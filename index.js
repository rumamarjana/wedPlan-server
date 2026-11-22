import express from "express";
import cors from "cors";
import "dotenv/config";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Vercel assigns the client a public *.vercel.app URL for every production and
// preview deployment. Allowing those origins keeps /auth/token (and therefore
// bookings) working without editing CLIENT_ORIGIN on every deploy. Explicit
// CLIENT_ORIGIN entries and simple wildcard patterns are still supported.
function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser requests (curl, server-to-server)
  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i.test(origin)) return true;
  return allowedOrigins.some((pattern) => {
    if (!pattern.includes("*")) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(origin);
  });
}

app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Origin not allowed"));
    }
  },
  credentials: true,
}));

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
const db = mongo.db(process.env.MONGODB_DB_NAME || "wedplandb");
const users = db.collection("users");
const services = db.collection("services");
const bookings = db.collection("bookings");
const transactions = db.collection("transactions");

await Promise.all([
  services.createIndex({ vendorId: 1, status: 1 }),
  services.createIndex({ serviceName: "text", category: "text", location: "text" }),
  bookings.createIndex({ serviceId: 1, customerId: 1, eventDate: 1 }),
  transactions.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true }),
]);

const jwtSecret = process.env.JWT_SECRET || process.env.BETTER_AUTH_SECRET;
if (!jwtSecret) throw new Error("JWT_SECRET or BETTER_AUTH_SECRET is required");

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

function id(value) {
  return ObjectId.isValid(String(value)) ? new ObjectId(String(value)) : null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    image: user.image || null,
    role: user.role || "customer",
    isBlocked: Boolean(user.isBlocked),
    businessName: user.businessName || "",
    subscriptionPlan: user.subscriptionPlan || "free",
    subscriptionExpiresAt: user.subscriptionExpiresAt || null,
  };
}

async function findBetterAuthSession(token) {
  const session = await db.collection("session").findOne({ token });
  if (!session) return null;
  const expiresAt = session.expiresAt ? new Date(session.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() < Date.now()) return null;
  return session;
}

async function authenticate(req, res, next) {
  try {
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: "Authentication required" });

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch {
      const session = await findBetterAuthSession(token);
      if (!session) return res.status(401).json({ success: false, message: "Invalid or expired token" });
      payload = { userId: String(session.userId), role: null };
    }

    const userId = id(payload.userId);
    if (!userId) return res.status(401).json({ success: false, message: "Invalid token identity" });
    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(401).json({ success: false, message: "User not found" });
    if (user.isBlocked) return res.status(403).json({ success: false, message: "Account is blocked" });

    req.user = publicUser(user);
    req.userDocument = user;
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    next();
  };
}

async function syncUser(req, res) {
  const authUser = req.body;
  if (!authUser?.id || !authUser?.email) {
    return res.status(400).json({ success: false, message: "Valid user identity is required" });
  }
  const userId = id(authUser.id);
  if (!userId) return res.status(400).json({ success: false, message: "Invalid user id" });

  await users.updateOne(
    { _id: userId },
    {
      $set: {
        name: String(authUser.name || ""),
        email: String(authUser.email),
        image: authUser.image || null,
        role: ["vendor", "admin"].includes(authUser.role) ? authUser.role : "customer",
        updatedAt: new Date(),
      },
      $setOnInsert: {
        isBlocked: false,
        businessName: "",
        subscriptionPlan: "free",
        subscriptionExpiresAt: null,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  const user = await users.findOne({ _id: userId });
  const token = jwt.sign({ userId: String(user._id), role: user.role }, jwtSecret, { expiresIn: "7d" });
  res.json({ success: true, user: publicUser(user), token });
}

app.get("/", (_req, res) => res.json({ success: true, name: "WedPlan API" }));
app.get("/health", (_req, res) => res.status(200).json({ status: "healthy" }));

app.post("/auth/token", express.json(), async (req, res) => {
  const { sessionToken, user } = req.body || {};
  if (!sessionToken) return res.status(401).json({ success: false, message: "Session token is required" });
  const session = await findBetterAuthSession(sessionToken);
  if (!session) return res.status(401).json({ success: false, message: "Invalid session" });

  const userId = id(session.userId);
  if (!userId) return res.status(401).json({ success: false, message: "Invalid session identity" });
  let account = await users.findOne({ _id: userId });
  if (user?.id) {
    // Better Auth is the source of truth for the role. Preserve an existing
    // API role when an older session has no role attached, and default to
    // "customer" for brand-new accounts so the upsert always succeeds.
    const role = ["vendor", "admin", "customer"].includes(user.role)
      ? user.role
      : account?.role || "customer";
    await users.updateOne(
      { _id: userId },
      {
        $set: {
          name: user.name || "",
          email: user.email,
          image: user.image || null,
          role,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          isBlocked: false,
          businessName: "",
          subscriptionPlan: "free",
          subscriptionExpiresAt: null,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    account = await users.findOne({ _id: userId });
  }
  if (!account) return res.status(404).json({ success: false, message: "User profile not found" });
  if (account.isBlocked) return res.status(403).json({ success: false, message: "Account is blocked" });

  const token = jwt.sign({ userId: String(account._id), role: account.role }, jwtSecret, { expiresIn: "7d" });
  res.json({ success: true, user: publicUser(account), token });
});

app.post("/users/sync", express.json(), syncUser);
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook/stripe") return next();
  return express.json()(req, res, next);
});

app.get("/users/me", authenticate, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.patch("/users/me", authenticate, async (req, res) => {
  const allowed = {};
  if (typeof req.body.name === "string") allowed.name = req.body.name.trim();
  if (typeof req.body.image === "string") allowed.image = req.body.image;
  if (req.user.role === "vendor" && typeof req.body.businessName === "string") {
    allowed.businessName = req.body.businessName.trim();
  }
  if (!Object.keys(allowed).length) {
    return res.status(400).json({ success: false, message: "No editable profile fields provided" });
  }
  await users.updateOne({ _id: id(req.user.id) }, { $set: { ...allowed, updatedAt: new Date() } });
  const user = await users.findOne({ _id: id(req.user.id) });
  res.json({ success: true, user: publicUser(user) });
});

app.get("/services", async (req, res) => {
  try {
    const query = {};
    if (req.query.category) query.category = String(req.query.category);
    if (req.query.location) query.location = { $regex: String(req.query.location), $options: "i" };
    if (req.query.packageType) query.packageType = String(req.query.packageType);
    if (req.query.search) {
      query.$or = [
        { serviceName: { $regex: String(req.query.search), $options: "i" } },
        { description: { $regex: String(req.query.search), $options: "i" } },
        { category: { $regex: String(req.query.search), $options: "i" } },
        { location: { $regex: String(req.query.search), $options: "i" } },
      ];
    }
    if (req.query.approvedOnly === "true") {
      query.status = "approved";
      query.active = true;
    }
    if (req.query.status) query.status = String(req.query.status);
    if (req.query.active !== undefined) query.active = req.query.active === "true";

    let cursor = services.find(query);
    if (req.query.sort === "priceAsc") cursor = cursor.sort({ basePrice: 1 });
    if (req.query.sort === "priceDesc") cursor = cursor.sort({ basePrice: -1 });
    if (req.query.sort === "newest") cursor = cursor.sort({ createdAt: -1 });
    const result = await cursor.toArray();
    res.json(result);
  } catch (error) {
    console.error("Get services error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch services" });
  }
});

app.get("/services/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid service id" });
  const service = await services.findOne({ _id: new ObjectId(req.params.id) });
  if (!service) return res.status(404).json({ success: false, message: "Service not found" });
  res.json(service);
});

app.post("/services", authenticate, allowRoles("vendor"), async (req, res) => {
  const required = ["serviceName", "category", "description", "basePrice", "location"];
  if (required.some((field) => !req.body[field])) {
    return res.status(400).json({ success: false, message: "Required service fields are missing" });
  }
  const activeServices = await services.countDocuments({
    vendorId: req.user.id,
    active: true,
  });
  if (req.user.subscriptionPlan !== "premium" && activeServices >= 3) {
    return res.status(402).json({ success: false, message: "Free plan allows a maximum of 3 active services" });
  }

  const newService = {
    ...req.body,
    basePrice: String(req.body.basePrice),
    vendorId: req.user.id,
    vendorName: req.user.businessName || req.user.name,
    images: Array.isArray(req.body.images) ? req.body.images : [],
    features: Array.isArray(req.body.features) ? req.body.features : [],
    status: "pending",
    active: req.body.active !== false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await services.insertOne(newService);
  res.status(201).json({ success: true, service: { ...newService, _id: result.insertedId } });
});

app.patch("/services/:id", authenticate, allowRoles("vendor", "admin"), async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid service id" });
  const service = await services.findOne({ _id: new ObjectId(req.params.id) });
  if (!service) return res.status(404).json({ success: false, message: "Service not found" });
  if (req.user.role === "vendor" && service.vendorId !== req.user.id) {
    return res.status(403).json({ success: false, message: "You do not own this service" });
  }

  const allowed = {};
  ["serviceName", "category", "description", "basePrice", "location", "duration", "durationUnit", "images", "features", "packageType", "active", "status"].forEach((field) => {
    if (req.body[field] !== undefined) allowed[field] = req.body[field];
  });
  if (req.user.role === "vendor") delete allowed.status;
  await services.updateOne({ _id: service._id }, { $set: { ...allowed, updatedAt: new Date() } });
  res.json({ success: true, service: await services.findOne({ _id: service._id }) });
});

app.delete("/services/:id", authenticate, allowRoles("vendor", "admin"), async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid service id" });
  const service = await services.findOne({ _id: new ObjectId(req.params.id) });
  if (!service) return res.status(404).json({ success: false, message: "Service not found" });
  if (req.user.role === "vendor" && service.vendorId !== req.user.id) {
    return res.status(403).json({ success: false, message: "You do not own this service" });
  }
  await services.deleteOne({ _id: service._id });
  res.json({ success: true });
});

app.post("/bookings", authenticate, allowRoles("customer"), async (req, res) => {
  const { serviceId, eventDate, eventLocation, message } = req.body;
  if (!serviceId || !eventDate || !eventLocation) {
    return res.status(400).json({ success: false, message: "Service, event date and location are required" });
  }
  if (!ObjectId.isValid(serviceId)) return res.status(400).json({ success: false, message: "Invalid service id" });
  // Legacy/seeded services have no moderation status, but they are published
  // in the catalog, so treat them as approved. Pending/rejected services stay
  // unbookable until an admin approves them.
  const service = await services.findOne({
    _id: new ObjectId(serviceId),
    active: true,
    status: { $nin: ["pending", "rejected"] },
  });
  if (!service) return res.status(404).json({ success: false, message: "Approved active service not found" });
  if (service.vendorId === req.user.id) return res.status(403).json({ success: false, message: "You cannot book your own service" });

  const duplicate = await bookings.findOne({
    serviceId,
    customerId: req.user.id,
    eventDate,
    status: { $in: ["Pending", "Accepted"] },
  });
  if (duplicate) return res.status(409).json({ success: false, message: "An active booking already exists for this date" });

  const booking = {
    serviceId,
    vendorId: service.vendorId,
    customerId: req.user.id,
    eventDate,
    eventLocation,
    message: message || "",
    status: "Pending",
    createdAt: new Date(),
  };
  const result = await bookings.insertOne(booking);
  res.status(201).json({ success: true, booking: { ...booking, _id: result.insertedId } });
});

app.get("/bookings/my", authenticate, async (req, res) => {
  const query = req.user.role === "vendor"
    ? { vendorId: req.user.id }
    : req.user.role === "customer"
      ? { customerId: req.user.id }
      : {};
  const result = await bookings.find(query).sort({ createdAt: -1 }).toArray();
  res.json(result);
});

app.patch("/bookings/:id/status", authenticate, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid booking id" });
  const booking = await bookings.findOne({ _id: new ObjectId(req.params.id) });
  if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
  const status = req.body.status;

  if (req.user.role === "vendor" && ["Accepted", "Rejected"].includes(status)) {
    if (booking.vendorId !== req.user.id) return res.status(403).json({ success: false, message: "Forbidden" });
    if (booking.status !== "Pending") return res.status(409).json({ success: false, message: "Booking has already been processed" });
  } else if (req.user.role === "customer" && status === "Cancelled") {
    if (booking.customerId !== req.user.id) return res.status(403).json({ success: false, message: "Forbidden" });
    if (booking.status !== "Pending") return res.status(409).json({ success: false, message: "Only pending bookings can be cancelled" });
  } else {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  await bookings.updateOne({ _id: booking._id }, { $set: { status, updatedAt: new Date() } });
  res.json({ success: true, booking: await bookings.findOne({ _id: booking._id }) });
});

app.get("/admin/stats", authenticate, allowRoles("admin"), async (_req, res) => {
  const [totalUsers, vendors, customers, totalServices, pendingServices, totalTransactions, blockedUsers] = await Promise.all([
    users.countDocuments({}), users.countDocuments({ role: "vendor" }), users.countDocuments({ role: "customer" }),
    services.countDocuments({}), services.countDocuments({ status: "pending" }),
    transactions.countDocuments({}), users.countDocuments({ isBlocked: true }),
  ]);
  res.json({ success: true, stats: { totalUsers, vendors, customers, totalServices, pendingServices, totalTransactions, blockedUsers } });
});

app.get("/admin/users", authenticate, allowRoles("admin"), async (req, res) => {
  const query = {};
  if (req.query.role) query.role = String(req.query.role);
  if (req.query.search) {
    query.$or = [
      { name: { $regex: String(req.query.search), $options: "i" } },
      { email: { $regex: String(req.query.search), $options: "i" } },
    ];
  }
  const result = await users.find(query).sort({ createdAt: -1 }).toArray();
  res.json(result.map(publicUser));
});

app.patch("/admin/users/:id/block", authenticate, allowRoles("admin"), async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid user id" });
  const target = await users.findOne({ _id: new ObjectId(req.params.id) });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  await users.updateOne({ _id: target._id }, { $set: { isBlocked: Boolean(req.body.isBlocked), updatedAt: new Date() } });
  res.json({ success: true, user: publicUser(await users.findOne({ _id: target._id })) });
});

app.get("/admin/transactions", authenticate, allowRoles("admin"), async (_req, res) => {
  res.json(await transactions.find({}).sort({ createdAt: -1 }).toArray());
});

app.post("/subscriptions/checkout", authenticate, allowRoles("vendor"), async (req, res) => {
  if (!stripe) return res.status(503).json({ success: false, message: "Stripe is not configured" });
  const origin = req.get("origin") || allowedOrigins[0];
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: process.env.STRIPE_PREMIUM_PRICE_ID, quantity: 1 }],
    success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/payment/cancel`,
    client_reference_id: req.user.id,
    metadata: { vendorId: req.user.id, plan: "premium" },
    subscription_data: { metadata: { vendorId: req.user.id, plan: "premium" } },
  });
  res.json({ success: true, url: session.url });
});

app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(503).send("Stripe is not configured");
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const vendorId = session.metadata?.vendorId || session.client_reference_id;
    if (!vendorId) return res.status(400).json({ received: false });
    await users.updateOne(
      { _id: id(vendorId) },
      { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: null, updatedAt: new Date() } },
    );
    await transactions.updateOne(
      { stripeSessionId: session.id },
      {
        $set: {
          vendorId,
          plan: "premium",
          amount: session.amount_total || 0,
          currency: session.currency || "usd",
          status: "succeeded",
          stripeSessionId: session.id,
          stripeSubscriptionId: session.subscription || null,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
    const subscription = event.data.object;
    const vendorId = subscription.metadata?.vendorId;
    if (vendorId) {
      await users.updateOne(
        { _id: id(vendorId) },
        {
          $set: {
            subscriptionPlan: subscription.status === "active" ? "premium" : "free",
            subscriptionExpiresAt: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
          },
        },
      );
    }
  }
  res.json({ received: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.message === "Origin not allowed" ? 403 : 500).json({ success: false, message: err.message || "Server error" });
});

const server = app.listen(port, () => console.log(`WedPlan server running on port ${port}`));

async function shutdown(signal) {
  console.log(`${signal} received; closing server`);
  server.close(async () => {
    await mongo.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));


export default app;