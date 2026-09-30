import { auth, db, authPersistenceReady } from "./firebase-config.js";
import { signInWithEmailAndPassword, sendPasswordResetEmail, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { ref, update, increment, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

// 항상 같은 오리진(현재 페이지를 서빙하는 Worker)으로 호출합니다. 예전엔 lagem1535 계정의
// workers.dev 주소를 절대경로로 하드코딩했는데, 이러면 다른 도메인(ramalok.kr 등)에서
// 열었을 때 실제 브라우저 크로스오리진 요청이 되어 그 워커의 ALLOWED_ORIGINS에 없는 한
// CORS로 막힙니다. 상대경로로 두면 무조건 지금 페이지를 서빙 중인 Worker로 가서 안전합니다.
const API_BASE = "";

const form = document.querySelector("#loginForm");
const email = document.querySelector("#email");
const password = document.querySelector("#password");
const resetBtn = document.querySelector("#resetBtn");
const message = document.querySelector("#message");
let redirecting = false;

function showMessage(text, error = false) {
  message.textContent = text;
  message.className = `message ${error ? "error" : "success"}`;
}

async function recordLogin(user) {
  try {
    await update(ref(db, `users/${user.uid}/profile`), {
      email: user.email,
      lastLoginAt: serverTimestamp(),
      loginCount: increment(1),
    });
  } catch {
    // 로그인 기록 실패는 로그인 자체를 막지 않습니다.
  }
}

async function afterAuth(user) {
  if (redirecting) return;
  redirecting = true;
  try {
    const idToken = await user.getIdToken();
    const res = await fetch(`${API_BASE}/api/access-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.banned) {
      await signOut(auth);
      redirecting = false;
      showMessage("이용이 제한된 계정입니다.", true);
      return;
    }
  } catch {
    // 차단 여부 확인이 실패해도 서버 장애로 전원 로그인이 막히지 않도록 로그인은 허용합니다.
  }
  recordLogin(user);
  window.location.replace("../main/");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("로그인 중...");
  try {
    await authPersistenceReady;
    const credential = await signInWithEmailAndPassword(auth, email.value.trim(), password.value);
    afterAuth(credential.user);
  } catch (error) {
    showMessage(firebaseErrorMessage(error.code), true);
  }
});

resetBtn.addEventListener("click", async () => {
  const emailValue = email.value.trim();
  if (!emailValue) {
    showMessage("비밀번호를 재설정할 이메일을 입력해주세요.", true);
    return;
  }
  try {
    await sendPasswordResetEmail(auth, emailValue);
    showMessage("비밀번호 재설정 이메일을 보냈습니다.");
  } catch (error) {
    showMessage(firebaseErrorMessage(error.code), true);
  }
});

onAuthStateChanged(auth, (user) => {
  if (user) afterAuth(user);
});

try {
  if (sessionStorage.getItem("pr_banned_notice")) {
    sessionStorage.removeItem("pr_banned_notice");
    showMessage("이용이 제한된 계정입니다.", true);
  }
} catch { /* 무시 */ }

function firebaseErrorMessage(code) {
  const messages = {
    "auth/invalid-credential": "이메일 또는 비밀번호가 올바르지 않습니다.",
    "auth/user-not-found": "가입된 계정을 찾을 수 없습니다.",
    "auth/wrong-password": "비밀번호가 올바르지 않습니다.",
    "auth/invalid-email": "이메일 형식이 올바르지 않습니다.",
    "auth/too-many-requests": "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
    "auth/network-request-failed": "네트워크 연결을 확인해주세요.",
    "auth/unauthorized-domain": "현재 사이트 주소가 Firebase 인증 허용 도메인에 등록되지 않았습니다."
  };
  return messages[code] || `오류가 발생했습니다. (${code})`;
}
