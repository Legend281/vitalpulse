import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBWJIygZ5moqqgNvEv_v-oba0MvKllvPLg",
  authDomain: "vitalpulse-fa458.firebaseapp.com",
  projectId: "vitalpulse-fa458",
  storageBucket: "vitalpulse-fa458.firebasestorage.app",
  messagingSenderId: "501893877118",
  appId: "1:501893877118:web:259f04174e4258108a372f"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);