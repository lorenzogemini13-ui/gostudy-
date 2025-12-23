// Firebase SDK Imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { 
  getAuth, 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

// YOUR SPECIFIC CONFIGURATION
export const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3000'
  : 'https://go-study-backend.onrender.com';

const firebaseConfig = {
  apiKey: "AIzaSyDWjdgDTwK-WFxaWoLZbVzGFHxqmociHaI",
  authDomain: "gostudy-7334c.firebaseapp.com",
  projectId: "gostudy-7334c",
  storageBucket: "gostudy-7334c.firebasestorage.app",
  messagingSenderId: "583210603138",
  appId: "1:583210603138:web:532c915ed82096f7929a9b",
  measurementId: "G-S1ZMJ0F26K"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// --- UI ELEMENTS ---
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const googleBtn = document.getElementById('google-btn');
const logoutBtn = document.getElementById('logout-btn');

// --- ERROR HANDLING TOAST ---
function showError(message) {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-6 right-6 bg-white text-dark px-6 py-4 rounded-2xl border border-gray-100 shadow-2xl transform transition-all duration-500 translate-y-20 z-[100] flex items-center gap-3`;
  toast.innerHTML = `
    <div class="w-8 h-8 rounded-full bg-red-50 text-red-500 flex items-center justify-center flex-shrink-0">
      <span class="material-icons-round text-sm">priority_high</span>
    </div>
    <span class="text-sm font-semibold">${message}</span>
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.remove('translate-y-20'), 10);
  setTimeout(() => {
    toast.classList.add('translate-y-20', 'opacity-0');
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

// --- 1. REGISTER ---
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reg-name').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const btn = document.getElementById('reg-submit-btn');

    try {
      btn.disabled = true;
      btn.innerHTML = `<span class="material-icons-round animate-spin text-sm">sync</span>`;
      
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(userCredential.user, { displayName: name });
      window.location.href = "/onboarding/";
    } catch (error) {
      btn.disabled = false;
      btn.innerHTML = "Create Account";
      showError(error.message.replace("Firebase: ", ""));
    }
  });
}

// --- 2. LOGIN ---
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const btn = document.getElementById('login-submit-btn');

    try {
      btn.disabled = true;
      btn.innerHTML = `<span class="material-icons-round animate-spin text-sm">sync</span>`;
      
      await signInWithEmailAndPassword(auth, email, password);
      window.location.href = "/dashboard/";
    } catch (error) {
      btn.disabled = false;
      btn.innerHTML = "Sign In";
      showError("Invalid email or password.");
    }
  });
}

// --- 3. GOOGLE ---
if (googleBtn) {
  googleBtn.addEventListener('click', async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      window.location.href = "/dashboard/";
    } catch (error) {
      showError("Social login failed.");
    }
  });
}

// --- 4. LOGOUT ---
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = "/index.html";
  });
}

// --- 5. AUTH PROTECTION ---
export { auth, onAuthStateChanged, signOut, updateProfile, updateEmail, updatePassword, deleteUser };

import { 
  updateEmail, 
  updatePassword, 
  deleteUser,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
  const path = window.location.pathname;
  const isLoginPage = path.includes('/login');
  const isDashboard = path.includes('/dashboard');
  const isProfilePage = path.includes('/profile');

  console.log(`[AUTH] State changed. User: ${user ? user.email : 'None'}. Path: ${path} (Profile: ${isProfilePage})`);

  if (user) {
    const display = document.getElementById('user-name-display');
    if (display) display.innerText = user.displayName || user.email.split('@')[0];
    if (isLoginPage) window.location.href = "/dashboard/";
    
    // Update navbar CTA to Profile when signed in
    try {
      const navCta = document.getElementById('nav-cta');
      if (navCta) {
        navCta.innerHTML = `<a class="bg-dark hover:bg-black text-white px-5 py-2.5 rounded-full text-sm font-medium transition-all" href="/profile/">Profile</a>`;
      }
      const dashLink = document.getElementById('nav-dashboard-link');
      if (dashLink) {
        dashLink.href = '/dashboard/';
      }
    } catch (e) {
      // ignore if DOM not present
    }

    // If on profile page, populate fields
    if (isProfilePage) {
        const nameInput = document.getElementById('profile-name');
        const emailInput = document.getElementById('profile-email');
        const nameText = document.getElementById('profile-display-name-text');
        const emailText = document.getElementById('profile-email-text');
        const profileImg = document.getElementById('profile-img-display');
        const profileInitials = document.getElementById('profile-initials');

        if (nameInput) nameInput.value = user.displayName || "";
        if (emailInput) emailInput.value = user.email || "";
        if (nameText) nameText.innerText = user.displayName || user.email.split('@')[0];
        if (emailText) emailText.innerText = user.email || "";
        
        if (user.photoURL) {
            if (profileImg) {
                profileImg.src = user.photoURL;
                profileImg.classList.remove('hidden');
            }
            if (profileInitials) profileInitials.classList.add('hidden');
        } else {
            if (profileInitials) {
                const initials = (user.displayName || user.email || "??").split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
                profileInitials.innerText = initials;
                profileInitials.classList.remove('hidden');
            }
            if (profileImg) profileImg.classList.add('hidden');
        }
    }

  } else {
    if (isDashboard || isProfilePage) window.location.href = "/login/";
    // Update navbar CTA to Get Started when signed out
    try {
      const navCta = document.getElementById('nav-cta');
      if (navCta) {
        navCta.innerHTML = `<a class="bg-dark hover:bg-black text-white px-5 py-2.5 rounded-full text-sm font-medium transition-all" href="/login/">Get Started</a>`;
      }
      const dashLink = document.getElementById('nav-dashboard-link');
      if (dashLink) {
        dashLink.href = '/login/';
      }
    } catch (e) {
      // ignore if DOM not present
    }
  }
});

// Helper for re-authentication (required for sensitive operations like email/password update)
export async function reauthenticate(currentPassword) {
    const user = auth.currentUser;
    if (!user || !user.email) return;
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    return reauthenticateWithCredential(user, credential);
}

// Global error handler for this module
window.showError = showError;