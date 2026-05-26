import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

// Using your exact Firebase configuration from the snippet
const firebaseConfig = {
  apiKey: "AIzaSyByJgpja2Jp4HrlrVwVSMed7mFuJ8cY7tI",
  authDomain: "delivery-tracker-3a043.firebaseapp.com",
  databaseURL: "https://delivery-tracker-3a043-default-rtdb.firebaseio.com",
  projectId: "delivery-tracker-3a043",
  storageBucket: "delivery-tracker-3a043.firebasestorage.app",
  messagingSenderId: "93985072546",
  appId: "1:93985072546:web:70d94bf210953d1f38befb"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize services and export them
export const auth = getAuth(app);
export const db = getDatabase(app);
export default app;
