import { auth, db, authPersistenceReady } from "../login/firebase-config.js";
import { createUserWithEmailAndPassword, updateProfile, deleteUser } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { ref, set } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

// 항상 같은 오리진(현재 페이지를 서빙하는 Worker)으로 호출합니다. 예전엔 lagem1535 계정의
// workers.dev 주소를 절대경로로 하드코딩했는데, 이러면 다른 도메인(ramalok.kr 등)에서
// 열었을 때 실제 브라우저 크로스오리진 요청이 되어 그 워커의 ALLOWED_ORIGINS에 없는 한
// CORS로 막힙니다. 상대경로로 두면 무조건 지금 페이지를 서빙 중인 Worker로 가서 안전합니다.
const API_BASE = "";

const form = document.querySelector("#signupForm");
const nickname = document.querySelector("#nickname");
const email = document.querySelector("#email");
const password = document.querySelector("#password");
const message = document.querySelector("#message");
let redirecting = false;

function showMessage(text, error = false) {
  message.textContent = text;
  message.className = `message ${error ? "error" : "success"}`;
}

function goMain() {
  if (redirecting) return;
  redirecting = true;
  window.location.replace("../main/");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nicknameValue = nickname.value.trim();
  const emailValue = email.value.trim();

  if (!nicknameValue || !emailValue || !password.value) {
    showMessage("닉네임, 이메일, 비밀번호를 입력해주세요.", true);
    return;
  }

  try {
    showMessage("회원가입 중...");
    await authPersistenceReady;
    const credential = await createUserWithEmailAndPassword(auth, emailValue, password.value);
    const user = credential.user;

    try {
      const idToken = await user.getIdToken();
      const banRes = await fetch(`${API_BASE}/api/access-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      const banData = await banRes.json().catch(() => ({}));
      if (banData.banned) {
        await deleteUser(user);
        showMessage("이용이 제한된 이메일입니다.", true);
        return;
      }
    } catch {
      // 차단 여부 확인이 실패해도 서버 장애로 회원가입 자체가 막히지 않도록 계속 진행합니다.
    }

    await updateProfile(user, { displayName: nicknameValue });
    await set(ref(db, `users/${user.uid}/profile`), {
      nickname: nicknameValue,
      email: user.email || emailValue,
      createdAt: new Date().toISOString()
    });

    showMessage("회원가입되었습니다.");
    goMain();
  } catch (error) {
    showMessage(firebaseErrorMessage(error.code), true);
  }
});

function firebaseErrorMessage(code) {
  const messages = {
    "auth/email-already-in-use": "이미 가입된 이메일입니다.",
    "auth/invalid-email": "이메일 형식이 올바르지 않습니다.",
    "auth/weak-password": "비밀번호는 6자 이상이어야 합니다.",
    "auth/network-request-failed": "네트워크 연결을 확인해주세요.",
    "auth/operation-not-allowed": "Firebase에서 이메일/비밀번호 로그인을 먼저 활성화해주세요.",
    "auth/unauthorized-domain": "현재 사이트 주소가 Firebase 인증 허용 도메인에 등록되지 않았습니다."
  };
  return messages[code] || `오류가 발생했습니다. (${code})`;
}
