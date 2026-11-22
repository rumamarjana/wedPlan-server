import assert from "node:assert/strict";

const baseUrl = process.env.API_BASE_URL || "http://localhost:5000";
const response = await fetch(`${baseUrl}/`);
assert.equal(response.ok, true);
const body = await response.json();
assert.equal(body.success, true);
console.log("WedPlan server smoke test passed");
