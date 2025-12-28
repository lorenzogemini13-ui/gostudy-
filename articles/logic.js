import { articles } from './data.js';

const grid = document.getElementById('articles-grid');
const modal = document.getElementById('article-modal');
const modalContent = document.getElementById('modal-content');
const searchInput = document.getElementById('search-input');
const categoryFilters = document.querySelectorAll('.category-btn');

let currentArticles = [...articles];

// --- INITIALIZE ---
function init() {
  renderArticles(currentArticles);
  setupEventListeners();
  setupModal();
}

// --- RENDER FUNCTIONS ---
function renderArticles(items) {
  grid.innerHTML = '';
  
  if (items.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full text-center py-20">
         <span class="material-icons-round text-6xl text-gray-200 mb-4">search_off</span>
         <p class="text-gray-500 text-lg">No articles found matching your criteria.</p>
      </div>
    `;
    return;
  }

  items.forEach(art => {
    const card = document.createElement('div');
    card.className = "group cursor-pointer bg-white rounded-3xl overflow-hidden border border-gray-100 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col h-full";
    card.setAttribute('data-id', art.id);
    card.innerHTML = `
      <div class="h-52 overflow-hidden relative">
        <img src="${art.image}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" alt="${art.title}">
        <div class="absolute top-4 left-4 bg-white/90 backdrop-blur-md px-3 py-1 rounded-full text-xs font-bold text-dark shadow-sm">
          ${art.category}
        </div>
      </div>
      <div class="p-8 flex flex-col flex-grow">
        <div class="flex items-center gap-3 text-xs font-semibold text-gray-400 mb-3">
          <span class="flex items-center gap-1"><span class="material-icons-round text-sm">schedule</span> ${art.readingTime}</span>
          <span>•</span>
          <span>${art.date}</span>
        </div>
        <h3 class="text-xl font-bold text-dark mb-3 group-hover:text-primary transition-colors line-clamp-2">${art.title}</h3>
        <p class="text-gray-500 text-sm leading-relaxed mb-6 line-clamp-3">${art.intro}</p>
        
        <div class="mt-auto pt-4 border-t border-gray-50 flex items-center justify-between">
           <div class="flex items-center gap-2">
             <div class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500 overflow-hidden">
                <img src="https://ui-avatars.com/api/?name=${art.author}&background=random" alt="${art.author}">
             </div>
             <span class="text-xs font-medium text-gray-500">${art.author}</span>
           </div>
           <span class="text-sm font-semibold text-primary flex items-center gap-1 group-hover:gap-2 transition-all">
             Read <span class="material-icons-round text-base">arrow_forward</span>
           </span>
        </div>
      </div>
    `;
    
    // Open Modal on Click
    card.addEventListener('click', () => openArticle(art));
    grid.appendChild(card);
  });
}

// --- FILTER & SEARCH ---
function setupEventListeners() {
  // Search
  searchInput.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    filterArticles(term, getActiveCategory());
  });

  // Categories
  categoryFilters.forEach(btn => {
    btn.addEventListener('click', () => {
      // Toggle active class
      categoryFilters.forEach(b => {
        b.classList.remove('bg-dark', 'text-white');
        b.classList.add('bg-white', 'text-gray-600', 'hover:bg-gray-50');
      });
      btn.classList.remove('bg-white', 'text-gray-600', 'hover:bg-gray-50');
      btn.classList.add('bg-dark', 'text-white');

      filterArticles(searchInput.value.toLowerCase(), btn.getAttribute('data-category'));
    });
  });
}

function getActiveCategory() {
  const activeBtn = Array.from(categoryFilters).find(b => b.classList.contains('bg-dark'));
  return activeBtn ? activeBtn.getAttribute('data-category') : 'All';
}

function filterArticles(term, category) {
  currentArticles = articles.filter(art => {
    const matchesTerm = art.title.toLowerCase().includes(term) || art.intro.toLowerCase().includes(term);
    const matchesCategory = category === 'All' || art.category === category;
    return matchesTerm && matchesCategory;
  });
  renderArticles(currentArticles);
}

// --- MODAL LOGIC ---
function setupModal() {
  document.getElementById('close-modal').addEventListener('click', closeArticle);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeArticle();
  });
  
  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeArticle();
    }
  });

  // Export Buttons
  document.getElementById('btn-export-md').addEventListener('click', () => exportMarkdown());
  document.getElementById('btn-print').addEventListener('click', () => window.print());
}

let activeArticle = null;

function openArticle(article) {
  activeArticle = article;
  
  // Populate Modal
  document.getElementById('modal-img').src = article.image;
  document.getElementById('modal-category').innerText = article.category;
  document.getElementById('modal-date').innerText = article.date;
  document.getElementById('modal-title').innerText = article.title;
  document.getElementById('modal-author').innerText = `By ${article.author}`;
  document.getElementById('modal-body').innerHTML = article.content;

  // Show
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden'; // Prevent background scrolling
}

function closeArticle() {
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  activeArticle = null;
}

// --- EXPORT LOGIC ---
function exportMarkdown() {
  if (!activeArticle) return;

  const mdContent = `
# ${activeArticle.title}
**Category:** ${activeArticle.category}
**Author:** ${activeArticle.author}
**Date:** ${activeArticle.date}

> ${activeArticle.intro}

---

${activeArticle.content.replace(/<[^>]*>/g, '')} 
  `; 
  // Note: A real HTML-to-MD converter would be better, but simple regex stripping works for this basic content or we could rely on the formatted intro/content if we stored MD in data.js. 
  // For now, let's make a cleaner version by just using the raw data fields since we don't have a library.
  
  const cleanMD = `
# ${activeArticle.title}

*Published on ${activeArticle.date} by ${activeArticle.author}*

## Introduction
${activeArticle.intro}

## Content
(Content is formatted for web. Please visit the site for full rich text.)

${activeArticle.content.replace(/<h3[^>]*>(.*?)<\/h3>/g, "\n### $1\n").replace(/<p[^>]*>(.*?)<\/p>/g, "\n$1\n").replace(/<li[^>]*>(.*?)<\/li>/g, "- $1\n").replace(/<[^>]*>/g, "")}
  `;

  const blob = new Blob([cleanMD], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${activeArticle.title.replace(/\s+/g, '-').toLowerCase()}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// Start
init();
