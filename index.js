import express from 'express';
import { MongoClient } from 'mongodb';
import cors from 'cors';
import 'dotenv/config'


const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(express.json());
app.use(cors());

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}





app.get('/', (req, res) => {
  res.send('welcome to wedPlan-server');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});