import { auth, API_BASE } from "/backend/js/auth.js";

// --- CONFIG & STATE ---
const API_URL = `${API_BASE}/api/generate-plan`;
let selectedDifficulty = "High School";
let currentData = null;
let answersVisible = false;

const UI = {
  upload: document.getElementById("upload-section"),
  loading: document.getElementById("loading-section"),
  results: document.getElementById("results-section"),
  error: document.getElementById("validation-error"),
  fileInput: document.getElementById("file-input"),
  bar: document.getElementById("loading-bar"),
  percent: document.getElementById("loading-percent"),
  diffBtns: document.querySelectorAll(".difficulty-btn")
};

// --- DIFFICULTY PICKER LOGIC ---
UI.diffBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    UI.diffBtns.forEach(b => {
      b.classList.remove('bg-white', 'shadow-sm', 'ring-1', 'ring-black/5', 'text-dark');
      b.classList.add('text-gray-400', 'hover:text-dark');
    });
    btn.classList.add('bg-white', 'shadow-sm', 'ring-1', 'ring-black/5', 'text-dark');
    btn.classList.remove('text-gray-400', 'hover:text-dark');
    selectedDifficulty = btn.getAttribute('data-level');
  });
});

// --- API SERVICE ---
const StudyAPI = {
  async generatePlan(file, difficulty) {
    const formData = new FormData();
    formData.append("document", file);
    formData.append("difficulty", difficulty);

    const headers = {};
    if (auth.currentUser) {
      const token = await auth.currentUser.getIdToken();
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(API_URL, {
      method: "POST",
      body: formData,
      headers: headers
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Server Error: ${response.status}`);
    }
    return await response.json();
  }
};

// --- MAIN HANDLER ---
UI.fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  UI.error.classList.add("hidden");
  if (file.size > 5 * 1024 * 1024) {
    showError(`File is too large. Maximum size is 5MB.`);
    return;
  }

  // UI Transition
  UI.upload.style.display = "none";
  UI.loading.classList.remove("hidden");
  UI.loading.style.display = "flex";

  let progress = 0;
  const progressInterval = setInterval(() => {
    if (progress < 90) {
      progress += Math.random() * 2;
      const display = Math.min(Math.round(progress), 90);
      UI.bar.style.width = `${display}%`;
      UI.percent.textContent = `${display}%`;
    }
  }, 500);

  try {
    const data = await StudyAPI.generatePlan(file, selectedDifficulty);
    clearInterval(progressInterval);
    UI.bar.style.width = "100%";
    UI.percent.textContent = "100%";
    renderDashboard(data);
  } catch (err) {
    clearInterval(progressInterval);
    handleError(err);
  }
});

function showError(msg) {
  UI.error.textContent = msg;
  UI.error.classList.remove("hidden");
}

function handleError(err) {
  UI.loading.innerHTML = `
    <div class="text-red-500 p-8">
      <h3 class="text-xl font-bold">Analysis Failed</h3>
      <p class="mt-2 mb-4 text-sm">${err.message}</p>
      <button onclick="location.reload()" class="bg-gray-200 px-4 py-2 rounded font-bold hover:bg-gray-300 text-dark transition-colors">Try Again</button>
    </div>
  `;
}

// --- RENDERING FUNCTIONS ---
function renderDashboard(data) {
  currentData = data;
  UI.loading.style.display = "none";
  UI.results.style.display = "block";
  UI.results.classList.remove("hidden");

  document.getElementById("result-summary").innerText = data.summary || "No summary available.";
  document.getElementById("result-palace").innerText = data.memory_palace || "No memory palace available.";

  const quizDiv = document.getElementById("result-quiz");
  quizDiv.innerHTML = "";
  if (data.active_recall?.length) {
    data.active_recall.forEach((q, i) => {
      const div = document.createElement("div");
      div.className = "mb-4 pb-1";
      div.innerHTML = `
        <p class="font-semibold text-gray-800 mb-1 leading-snug"><span class="text-green-600 font-bold mr-2">${i+1}.</span> ${q.question}</p>
        <p class="quiz-answer text-sm text-gray-500 font-medium ml-6 opacity-0 h-0 overflow-hidden transition-all duration-300 ease-out">${q.answer}</p>
      `;
      quizDiv.appendChild(div);
    });
  }

  const schedDiv = document.getElementById("result-schedule");
  schedDiv.innerHTML = "";
  if (data.spaced_repetition?.length) {
    data.spaced_repetition.forEach(s => {
      const div = document.createElement("div");
      div.className = "flex gap-4 mb-4 items-start";
      div.innerHTML = `
        <span class="bg-orange-100/80 text-orange-600 text-[10px] font-extrabold px-2 py-1 rounded-md min-w-[50px] text-center uppercase tracking-wide mt-0.5">${s.day}</span>
        <span class="text-sm text-gray-600 font-medium leading-relaxed">${s.topic}</span>
      `;
      schedDiv.appendChild(div);
    });
  }

  renderBadge(data);
  UI.results.scrollIntoView({ behavior: "smooth" });
}

// --- HELPERS (Exports & Toggles) ---
window.toggleAnswers = function() {
  answersVisible = !answersVisible;
  document.querySelectorAll(".quiz-answer").forEach(a => {
    if (answersVisible) a.classList.remove("opacity-0", "h-0", "overflow-hidden");
    else a.classList.add("opacity-0", "h-0", "overflow-hidden");
  });
};

window.exportMarkdown = function() {
  if (!currentData) return;
  const md = `# Study Plan (${selectedDifficulty})\n\n## Summary\n${currentData.summary}...`;
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `study-plan-${selectedDifficulty.toLowerCase()}.md`;
  a.click();
};

window.exportPDF = function() {
  const element = document.getElementById("results-section");
  html2pdf().set({ margin: 0.5, filename: "study-plan.pdf", html2canvas: { scale: 2 } }).from(element).save();
};

function renderBadge(data) {
  const text = (data.summary + " " + (data.active_recall?.[0]?.question || "")).toLowerCase();
  let config = { icon: "verified", bg: "bg-blue-50/50", text: "text-blue-700", label: "Scientifically Optimized" };
  
  if (text.match(/biology|cell|physics|chemistry|science/)) config = { icon: "biotech", bg: "bg-emerald-50/80", text: "text-emerald-700", label: "Science-Verified" };
  
  document.getElementById("methodology-badge-container").innerHTML = `
    <div class="group relative">
      <div class="absolute -inset-1 bg-gradient-to-r from-blue-400 to-indigo-400 rounded-2xl blur opacity-25"></div>
      <div class="${config.bg} border-2 border-white/50 px-10 py-6 rounded-2xl text-center relative flex flex-col items-center gap-3 backdrop-blur-sm">
        <div class="flex items-center gap-2">
          <span class="material-icons-round ${config.text} text-3xl">${config.icon}</span>
          <span class="font-black ${config.text} tracking-tighter text-lg uppercase">${config.label}</span>
        </div>
        <p class="text-gray-500 text-xs font-bold uppercase tracking-widest">Level: ${selectedDifficulty}</p>
      </div>
    </div>
  `;
}
