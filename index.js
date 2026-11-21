import express from 'express';
import { MongoClient } from 'mongodb';
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
const services = database.collection('service');




app.get('/', (req, res) => {
  res.send('welcome to wedPlan-server');
});


// user 
app.get('/users', async (req, res) => {
   const cursor = users.find({});
   const result = await cursor.toArray();
   res.send(result);
})




app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});