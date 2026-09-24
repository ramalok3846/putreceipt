import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCXqCgMZV-8bRwy3cqT21mFToAkd2o4kiA",
  authDomain: "fir-2-f3b80.firebaseapp.com",
  databaseURL: "https://fir-2-f3b80-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "fir-2-f3b80",
  storageBucket: "fir-2-f3b80.firebasestorage.app",
  messagingSenderId: "502189480871",
  appId: "1:502189480871:web:80af63a9d8f7495a3bf482",
  measurementId: "G-JX1YT4S8N3"
};

const app = initializeApp(firebaseConfig);

// 모든 페이지가 반드시 같은 Firebase App / RTDB 인스턴스를 사용하도록 공유합니다.
export const auth = getAuth(app);
export const db = getDatabase(app);
export const authPersistenceReady = setPersistence(auth, browserLocalPersistence);
