import mongoose from "mongoose";

const DBconfig = async () => {
  const URI = process.env.URI;
  if (!URI) throw new Error("URI is required to start the application database connection.");
  await mongoose.connect(URI);
  console.log("Database successfully connected");
  return mongoose.connection;
};


export default  DBconfig ;
