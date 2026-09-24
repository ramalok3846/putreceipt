import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCEmf0KIiaF11nmS2CfBNA5yxZA9nrtmUU",
  authDomain: "pal-inte-db.firebaseapp.com",
  databaseURL: "https://pal-inte-db-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pal-inte-db",
  storageBucket: "pal-inte-db.firebasestorage.app",
  messagingSenderId: "411569829650",
  appId: "1:411569829650:web:b4d05e68c2fd1c4dd0e5cb",
  measurementId: "G-5HL52VSK1G"
};

const app = initializeApp(firebaseConfig);

// 모든 페이지가 반드시 같은 Firebase App / RTDB 인스턴스를 사용하도록 공유합니다.
export const auth = getAuth(app);
export const db = getDatabase(app);
export const authPersistenceReady = setPersistence(auth, browserLocalPersistence);
