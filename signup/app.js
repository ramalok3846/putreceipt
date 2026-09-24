import { auth, db, authPersistenceReady } from "../login/firebase-config.js";
import { createUserWithEmailAndPassword, updateProfile, deleteUser } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { ref, set } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

// GitHub Pages는 서버 함수를 실행할 수 없어서, 항상 Cloudflare Worker를 절대경로로 호출합니다.
const API_BASE = "https://putreceipt.lagem1535.workers.dev";

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
