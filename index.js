import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import 'dotenv/config'


const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(express.json());
app.use(cors());


const client = new MongoClient(process.env.MONGODB_URI);


export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}


const connectedClient = await connectToMongoDB();
const database = connectedClient.db('wedplandb');
const users = database.collection('user');
const services = database.collection('services');




app.get('/', (req, res) => {
  res.send('welcome to wedPlan-server');
});


// user 
app.get('/users', async (req, res) => {
   const cursor = users.find({});
   const result = await cursor.toArray();
   res.send(result);
})

// services related api

app.get('/services', async (req, res) => {

    const query = {};

    // Category filter
    if (req.query.category) {
        query.category = req.query.category;
    }

    // Location filter
    if (req.query.location) {
        query.location = {
            $regex: req.query.location,
            $options: 'i'
        };
    }

    // Package Type filter
    if (req.query.packageType) {
        query.packageType = req.query.packageType;
    }

    // Active services only
    if (req.query.active) {
        query.active = req.query.active === 'true';
    }

    // Search filter
    if (req.query.search) {
        query.$or = [
            {
                serviceName: {
                    $regex: req.query.search,
                    $options: 'i'
                }
            },
            {
                description: {
                    $regex: req.query.search,
                    $options: 'i'
                }
            },
            {
                category: {
                    $regex: req.query.search,
                    $options: 'i'
                }
            },
            {
                location: {
                    $regex: req.query.search,
                    $options: 'i'
                }
            },
            {
                features: {
                    $regex: req.query.search,
                    $options: 'i'
                }
            }
        ];
    }

    const cursor = servicesCollection.find(query);
    const result = await cursor.toArray();

    res.send(result);
});






app.post('/services', async (req, res) => {
  const service = req.body;
  const result = await services.insertOne(service);
  res.send(result);
});


app.get('/services', async (req, res) => {
  const cursor = services.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.delete('/services/:id', async (req, res) => {
  const result = await services.deleteOne({ _id: new ObjectId(req.params.id) });
  res.send(result);
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});