/**
 * Sequential Study Module
 * Manages step-by-step progression through study plan sections
 * with smooth transitions and JSON output structure
 */

/**
 * Sequential Study Module
 * Manages step-by-step progression through study plan sections
 * with smooth transitions and JSON output structure
 */

export class SequentialStudy {
  constructor(studyPlanData) {
    this.data = studyPlanData;
    this.currentSectionIndex = 0;
    this.sections = this.buildSections();
    this.container = null;
    this.onComplete = null;
  }

  /**
   * Build sections array from study plan data
   * Structure: Explanation → Examples → Mini-Quiz
   */
  buildSections() {
    const sections = [];

    // 1. explanation section (summary + concept map)
    sections.push({
      title: "Understanding the Concept",
      type: "explanation",
      content: {
        summary: this.data.summary || "",
        conceptMap: this.data.concept_map || null,
        objectives: this.data.learning_objectives || []
      },
      next_button: {
        text: "Continue to Examples",
        enabled: true
      }
    });

    // 2. example section (worked examples)
    if (this.data.worked_examples && this.data.worked_examples.length > 0) {
      sections.push({
        title: "See It in Action",
        type: "example",
        content: {
          examples: this.data.worked_examples
        },
        next_button: {
          text: "Continue to Quiz",
          enabled: true
        }
      });
    }

    // 3. mini-quiz section (3 questions max for quick assessment)
    if (this.data.active_recall && this.data.active_recall.length > 0) {
      const quizQuestions = this.data.active_recall.slice(0, 3);
      sections.push({
        title: "Test Your Understanding",
        type: "quiz",
        content: {
          questions: quizQuestions,
          currentQuestion: 0,
          score: 0
        },
        next_button: {
          text: "Finish Section",
          enabled: false // enabled after completing quiz
        }
      });
    }

    return sections;
  }

  /**
   * Get current section as JSON
   */
  getCurrentSection() {
    return this.sections[this.currentSectionIndex] || null;
  }

  /**
   * Get all sections as JSON array
   */
  getAllSectionsJSON() {
    return JSON.stringify(this.sections, null, 2);
  }

  /**
   * Move to next section with fade transition
   */
  async nextSection() {
    if (this.currentSectionIndex >= this.sections.length - 1) {
      if (this.onComplete) {
        this.onComplete();
      }
      return;
    }
    await this.fadeOut();
    this.currentSectionIndex++;
    await this.fadeIn();
  }

  /**
   * Move to previous section with fade transition
   */
  async prevSection() {
    if (this.currentSectionIndex <= 0) return;
    await this.fadeOut();
    this.currentSectionIndex--;
    await this.fadeIn();
  }

  /**
   * Render current section to container
   */
  render(containerElement) {
    this.container = containerElement;
    this.renderSection();
  }

  /**
   * Render the current section's content
   */
  renderSection() {
    if (!this.container) return;

    const section = this.getCurrentSection();
    if (!section) return;

    let contentHTML = '';

    // render based on section type
    switch (section.type) {
      case 'explanation':
        contentHTML = this.renderExplanation(section.content);
        break;
      case 'example':
        contentHTML = this.renderExample(section.content);
        break;
      case 'quiz':
        contentHTML = this.renderQuiz(section.content);
        break;
    }

    this.container.innerHTML = `
      <div class="sequential-section" data-section="${section.type}">
        <!-- progress indicator -->
        <div class="flex items-center justify-between mb-8">
          <div class="flex items-center gap-2">
            ${this.sections.map((s, idx) => `
              <div class="h-1.5 rounded-full transition-all duration-300 ${
                idx === this.currentSectionIndex 
                  ? 'w-12 bg-blue-600' 
                  : idx < this.currentSectionIndex 
                    ? 'w-8 bg-blue-400' 
                    : 'w-8 bg-gray-200'
              }"></div>
            `).join('')}
          </div>
          <span class="text-xs font-bold text-gray-400 uppercase tracking-wide">
            Step ${this.currentSectionIndex + 1} of ${this.sections.length}
          </span>
        </div>

        <!-- section header -->
        <div class="mb-10">
          <h2 class="text-3xl font-bold text-gray-900 mb-2 tracking-tight">
            ${section.title}
          </h2>
          <div class="h-1 w-16 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full"></div>
        </div>

        <!-- section content -->
        <div class="section-content mb-10">
          ${contentHTML}
        </div>

        <!-- navigation buttons -->
        <div class="flex items-center justify-between mt-12 pt-8 border-t border-gray-100">
          <div>
            ${this.currentSectionIndex > 0 ? `
              <button 
                id="back-btn"
                class="flex items-center gap-2 px-6 py-3 rounded-xl text-gray-500 font-bold hover:bg-gray-50 hover:text-gray-900 transition-all group"
              >
                <span class="material-icons-round text-gray-400 group-hover:text-gray-900 transition-colors">arrow_back</span>
                <span>Back</span>
              </button>
            ` : ''}
          </div>

          <button 
            id="continue-btn"
            class="flex items-center gap-3 px-8 py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold shadow-lg shadow-blue-500/30 hover:shadow-xl hover:scale-105 transition-all duration-300 ${
              !section.next_button.enabled ? 'opacity-50 cursor-not-allowed' : ''
            }"
            ${!section.next_button.enabled ? 'disabled' : ''}
          >
            <span>${section.next_button.text}</span>
            <span class="material-icons-round">arrow_forward</span>
          </button>
        </div>
      </div>
    `;

    // attach event listeners
    const continueBtn = this.container.querySelector('#continue-btn');
    if (continueBtn && section.next_button.enabled) {
      continueBtn.addEventListener('click', () => this.nextSection());
    }

    const backBtn = this.container.querySelector('#back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => this.prevSection());
    }

    // initialize quiz if needed
    if (section.type === 'quiz') {
      this.initializeQuiz();
    }
    
    // Initializer concept map if needed
    if (section.type === 'explanation' && section.content.conceptMap) {
        this.renderConceptMap(section.content.conceptMap);
    }
  }

  /**
   * Render explanation section
   */
  renderExplanation(content) {
    let objectivesHTML = '';
    if (content.objectives && content.objectives.length > 0) {
      objectivesHTML = `
        <div class="bg-blue-50/50 border border-blue-100 rounded-2xl p-6 mb-8">
          <h4 class="text-xs font-bold text-blue-900 uppercase tracking-wide mb-4 flex items-center gap-2">
            <span class="material-icons-round text-lg text-blue-600">flag</span>
            Learning Objectives
          </h4>
          <ul class="space-y-3">
            ${content.objectives.map(obj => `
              <li class="flex items-start gap-3 text-gray-700">
                <span class="material-icons-round text-blue-500 text-sm mt-0.5">check_circle</span>
                <span class="text-sm font-medium leading-relaxed">${obj}</span>
              </li>
            `).join('')}
          </ul>
        </div>
      `;
    }

    // Concept map container (populated by renderConceptMap)
    let conceptMapHTML = '';
    if (content.conceptMap) {
      conceptMapHTML = `
        <div class="glass-panel p-8 rounded-3xl shadow-soft mb-8 border border-white/50 relative overflow-hidden group">
           <div class="absolute -right-10 -top-10 w-32 h-32 bg-purple-50 rounded-full blur-3xl opacity-50 pointer-events-none"></div>
           
           <div class="flex items-center gap-3 mb-8 relative z-10">
            <span class="w-10 h-10 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center shadow-sm">
              <span class="material-icons-round">hub</span>
            </span>
            <div>
              <h3 class="text-lg font-bold text-gray-900">Concept Map</h3>
              <p class="text-xs text-gray-500">Visual breakdown of topics</p>
            </div>
          </div>
          <div id="concept-map-container" class="flex flex-col items-center justify-center py-4 relative z-10"></div>
        </div>
      `;
    }

    // Enhanced summary formatting
    const formattedSummary = (content.summary || "No summary available.")
        .replace(/\*\*(.*?)\*\*/g, "<strong class='text-gray-900 bg-yellow-50 px-1 rounded'>$1</strong>")
        .replace(/\n/g, "<br>");

    return `
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div class="col-span-1 lg:col-span-2 space-y-8">
             <div class="glass-panel p-8 rounded-3xl shadow-soft border border-white/50 relative overflow-hidden">
                <div class="absolute -left-10 -top-10 w-32 h-32 bg-yellow-50 rounded-full blur-3xl opacity-50 pointer-events-none"></div>
                
                <div class="flex items-center gap-3 mb-6 relative z-10">
                  <span class="w-10 h-10 bg-yellow-100 text-yellow-600 rounded-xl flex items-center justify-center shadow-sm">
                    <span class="material-icons-round">lightbulb</span>
                  </span>
                  <div>
                    <h3 class="text-lg font-bold text-gray-900">Key Concepts</h3>
                    <p class="text-xs text-gray-500">Core summary of the material</p>
                  </div>
                </div>
                <div class="prose prose-lg max-w-none text-gray-700 leading-relaxed font-medium relative z-10">
                  ${formattedSummary}
                </div>
             </div>
             ${conceptMapHTML}
        </div>
        <div class="col-span-1">
             ${objectivesHTML}
             
             <!-- Help Tip -->
             <div class="bg-gray-50 rounded-2xl p-6 border border-gray-100">
                <div class="flex gap-3">
                    <span class="material-icons-round text-gray-400">info</span>
                    <p class="text-xs text-gray-500 leading-relaxed">
                        Take your time to understand the connections in the Concept Map before moving to examples.
                    </p>
                </div>
             </div>
        </div>
      </div>
    `;
  }

  /**
   * Render Concept Map logic (copied and adapted from index.html)
   */
  renderConceptMap(data) {
    const container = this.container.querySelector('#concept-map-container');
    if (!container) return;
    
    let html = '';
    
    if (data.main_topic) {
        // Hierarchical Object Structure
        const mainTopic = data.main_topic;
        const subtopics = data.subtopics || [];
        
        html = `
            <div class="concept-tree w-full flex flex-col items-center">
              <div class="concept-node main animate-enter" style="animation-delay: 0.1s">${mainTopic}</div>
              
              ${subtopics.length > 0 ? `
                <div class="concept-branches flex justify-center gap-4 relative pt-6 mt-0" style="width: 100%;">
                   <!-- Vertical connector from main -->
                   <div style="position: absolute; top: 0; left: 50%; width: 2px; height: 24px; background: #c7d7fe; transform: translateX(-50%);"></div>
                   
                   <!-- Horizontal connector line -->
                   <div class="concept-horizontal-line" style="position: absolute; top: 24px; height: 2px; background: #c7d7fe; left: ${100 / (subtopics.length * 2)}%; right: ${100 / (subtopics.length * 2)}%;"></div>

                   ${subtopics.map((topic, i) => `
                     <div class="concept-branch flex flex-col items-center relative pt-4 animate-enter" style="animation-delay: ${0.2 + (i * 0.1)}s">
                       <!-- Vertical connector to node -->
                       <div style="position: absolute; top: -6px; left: 50%; width: 2px; height: 22px; background: #c7d7fe; transform: translateX(-50%);"></div>
                       <div class="concept-node bg-white shadow-sm hover:shadow-md transition-all text-sm font-semibold">${topic}</div>
                     </div>
                   `).join('')}
                </div>
              ` : '<p class="text-gray-400 text-sm mt-4 italic">No subtopics available</p>'}
            </div>
        `;
    } else if (Array.isArray(data) && data.length > 0) {
        // Fallback Array Structure
        const mainTopic = data[0]?.concept || "Main Concept";
        const subtopics = data.slice(1).map(c => c.concept);
        
        html = `
            <div class="concept-tree w-full flex flex-col items-center">
              <div class="concept-node main animate-enter">${mainTopic}</div>
              ${subtopics.length > 0 ? `
                <div class="concept-branches flex justify-center gap-4 relative pt-6 mt-0">
                   <div style="position: absolute; top: 0; left: 50%; width: 2px; height: 24px; background: #c7d7fe; transform: translateX(-50%);"></div>
                   <div class="concept-horizontal-line" style="position: absolute; top: 24px; height: 2px; background: #c7d7fe; left: ${100 / (subtopics.length * 2)}%; right: ${100 / (subtopics.length * 2)}%;"></div>
                   ${subtopics.map((topic, i) => `
                        <div class="concept-branch flex flex-col items-center relative pt-4 animate-enter" style="animation-delay: ${0.1 * i}s">
                           <div style="position: absolute; top: -6px; left: 50%; width: 2px; height: 22px; background: #c7d7fe; transform: translateX(-50%);"></div>
                           <div class="concept-node bg-white shadow-sm hover:shadow-md">${topic}</div>
                        </div>
                   `).join('')}
                </div>
              ` : ''}
            </div>
        `;
    }
    
    container.innerHTML = html;
  }

  /**
   * Render example section
   */
  renderExample(content) {
    if (!content.examples || content.examples.length === 0) {
      return `
        <div class="text-center py-12 bg-gray-50 rounded-3xl border border-dashed border-gray-200">
            <span class="material-icons-round text-gray-300 text-4xl mb-2">auto_stories</span>
            <p class="text-gray-500 font-medium">No examples generated specifically for this topic.</p>
        </div>
      `;
    }

    return `
      <div class="grid grid-cols-1 gap-8">
        ${content.examples.map((example, idx) => {
             // Handle different data structures
             const title = example.title || `Example ${idx + 1}`;
             const problem = example.problem_statement || example.problem || example.content || "Problem statement not available.";
             const steps = Array.isArray(example.step_by_step_solution) ? example.step_by_step_solution : null;
             const solutionText = example.solution || (steps ? null : "Solution not available.");
             const finalResult = example.final_result || "";

             let solutionHTML = '';
             
             if (steps) {
                 solutionHTML = `
                    <div class="space-y-4">
                        ${steps.map((step, sIdx) => `
                            <div class="flex gap-4">
                                <div class="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold mt-1">
                                    ${sIdx + 1}
                                </div>
                                <div class="bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex-1 text-gray-700 text-sm leading-relaxed">
                                    <strong class="block text-gray-900 mb-1 text-xs uppercase tracking-wide opacity-50">Step ${sIdx + 1}</strong>
                                    ${step.step || step}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                 `;
             } else if (solutionText) {
                 solutionHTML = `
                    <div class="bg-blue-50/50 p-6 rounded-2xl border border-blue-100/50 text-gray-700 leading-relaxed">
                        ${solutionText.replace(/\n/g, "<br>")}
                    </div>
                 `;
             }

             return `
              <div class="glass-panel p-8 rounded-3xl shadow-soft border border-white/50 relative overflow-hidden transition-all duration-300 hover:shadow-lg">
                <div class="flex items-start gap-4 mb-6">
                  <span class="w-12 h-12 bg-gradient-to-br from-green-400 to-green-600 text-white rounded-2xl flex items-center justify-center font-bold text-lg shadow-lg shadow-green-500/20 flex-shrink-0">
                    ${idx + 1}
                  </span>
                  <div>
                    <h4 class="text-xl font-bold text-gray-900 mb-1">${title}</h4>
                    <span class="text-xs font-bold text-gray-400 uppercase tracking-wider bg-gray-50 px-2 py-1 rounded-md border border-gray-100">Worked Example</span>
                  </div>
                </div>

                <div class="bg-gray-900 rounded-2xl p-6 mb-8 text-white shadow-inner border border-gray-800 relative overflow-hidden">
                   <div class="absolute top-0 right-0 p-4 opacity-10">
                        <span class="material-icons-round text-6xl">code</span>
                   </div>
                   <p class="font-bold text-gray-400 text-xs uppercase tracking-widest mb-3">Problem Statement</p>
                   <div class="font-mono text-sm leading-relaxed text-gray-200">
                      ${problem}
                   </div>
                </div>

                <div class="mb-6">
                    <h5 class="flex items-center gap-2 text-sm font-bold text-gray-900 uppercase tracking-wide mb-4">
                        <span class="material-icons-round text-blue-500">psychology</span>
                        Solution Steps
                    </h5>
                    ${solutionHTML}
                </div>

                ${finalResult ? `
                    <div class="flex justify-end">
                        <div class="inline-flex items-center gap-3 bg-green-50 px-5 py-3 rounded-xl border border-green-100 text-green-700 font-bold text-sm">
                            <span class="material-icons-round">check_circle</span>
                            <span>Result: ${finalResult}</span>
                        </div>
                    </div>
                ` : ''}
              </div>
            `;
        }).join('')}
      </div>
    `;
  }

  /**
   * Render quiz section
   */
  renderQuiz(content) {
    const question = content.questions[content.currentQuestion];
    
    return `
      <div id="quiz-container" class="glass-panel p-10 rounded-3xl shadow-soft border border-white/60 relative overflow-hidden max-w-3xl mx-auto">
        <!-- Background decoration -->
        <div class="absolute -right-20 -top-20 w-64 h-64 bg-gradient-to-br from-blue-50 to-purple-50 rounded-full blur-3xl opacity-50 pointer-events-none"></div>

        <div class="mb-8 flex items-center justify-between relative z-10">
          <div class="flex items-center gap-3">
             <span class="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-sm">
                Q${content.currentQuestion + 1}
             </span>
             <span class="text-sm font-bold text-gray-400 uppercase tracking-wider">
                of ${content.questions.length} Questions
             </span>
          </div>
          <div class="flex gap-0.5 bg-gray-50 p-1 rounded-lg border border-gray-100">
            ${Array(5).fill(0).map((_, i) => 
              `<span class="material-icons-round text-[14px] ${i < (question.difficulty_rating || 3) ? 'text-yellow-400' : 'text-gray-200'}">star</span>`
            ).join('')}
          </div>
        </div>
        
        <h4 class="text-2xl font-bold text-slate-800 mb-8 leading-tight relative z-10">
          ${question.question}
        </h4>
        
        <div id="quiz-options" class="space-y-4 mb-8 relative z-10">
          ${question.type === 'multiple_choice' && question.options ? 
            question.options.map((option, idx) => `
              <button 
                class="quiz-option w-full text-left p-5 rounded-2xl border-2 border-gray-100 hover:border-blue-500 hover:bg-blue-50/50 hover:shadow-md active:scale-[0.99] transition-all group duration-200 bg-white"
                data-answer="${option}"
              >
                <div class="flex items-center gap-4">
                  <span class="w-8 h-8 rounded-xl bg-gray-100 text-gray-500 flex items-center justify-center text-xs font-bold group-hover:bg-blue-600 group-hover:text-white transition-all shadow-sm">
                    ${String.fromCharCode(65 + idx)}
                  </span>
                  <span class="text-gray-700 font-semibold text-base group-hover:text-gray-900">${option}</span>
                </div>
              </button>
            `).join('') 
            : `
              <div class="relative">
                 <textarea 
                    id="quiz-short-answer" 
                    class="w-full p-5 rounded-2xl border-2 border-gray-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 min-h-[140px] text-gray-800 text-base shadow-inner bg-gray-50/50 focus:bg-white transition-all outline-none resize-none"
                    placeholder="Type your answer here..."
                  ></textarea>
                  <div class="absolute bottom-4 right-4 text-xs text-gray-400 font-bold uppercase tracking-wider pointer-events-none">
                     Type Answer
                  </div>
              </div>
              <button 
                id="submit-short-answer"
                class="w-full py-4 mt-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold rounded-2xl shadow-lg shadow-blue-500/25 hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all"
              >
                Submit Answer
              </button>
            `
          }
        </div>
        
        <div id="quiz-feedback" class="hidden relative z-10 animate-enter"></div>
      </div>
    `;
  }

  /**
   * Initialize quiz interaction
   */
  initializeQuiz() {
    const section = this.getCurrentSection();
    if (section.type !== 'quiz') return;

    const options = this.container.querySelectorAll('.quiz-option');
    options.forEach(option => {
      option.addEventListener('click', (e) => {
        const answer = e.currentTarget.dataset.answer;
        this.submitQuizAnswer(answer);
      });
    });

    const shortAnswerBtn = this.container.querySelector('#submit-short-answer');
    if (shortAnswerBtn) {
      shortAnswerBtn.addEventListener('click', () => {
        const answer = this.container.querySelector('#quiz-short-answer').value.trim();
        if (answer) {
          this.submitQuizAnswer(answer);
        }
      });
    }
  }

  /**
   * Submit quiz answer and show feedback
   */
  submitQuizAnswer(userAnswer) {
    const section = this.getCurrentSection();
    const question = section.content.questions[section.content.currentQuestion];
    
    // Simple verification
    let isCorrect = false;
    if (question.type === 'multiple_choice') {
        isCorrect = userAnswer.toLowerCase().trim() === question.answer.toLowerCase().trim();
    } else {
        // Basic contains check for short answer
        isCorrect = userAnswer.toLowerCase().includes(question.answer.toLowerCase()) || 
                   question.answer.toLowerCase().includes(userAnswer.toLowerCase());
    }
    
    if (isCorrect) {
      section.content.score++;
    }

    // show feedback
    const feedbackDiv = this.container.querySelector('#quiz-feedback');
    feedbackDiv.classList.remove('hidden');
    feedbackDiv.innerHTML = `
      <div class="p-6 rounded-2xl ${isCorrect ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'} shadow-sm">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 rounded-full ${isCorrect ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'} flex items-center justify-center">
             <span class="material-icons-round text-xl">
                ${isCorrect ? 'check' : 'close'}
             </span>
          </div>
          <div>
              <span class="block text-xs font-bold uppercase tracking-wider ${isCorrect ? 'text-green-600' : 'text-red-600'}">Result</span>
              <span class="font-bold text-lg ${isCorrect ? 'text-green-900' : 'text-red-900'}">
                ${isCorrect ? 'Correct Answer!' : 'Incorrect'}
              </span>
          </div>
        </div>
        <p class="text-sm ${isCorrect ? 'text-green-800' : 'text-red-800'} mb-6 ml-13 leading-relaxed">
          ${isCorrect ? 'Excellent work! You nailed it.' : `The correct answer is: <strong>${question.answer}</strong>`}
        </p>
        
        <div class="flex justify-end">
             <button 
              id="next-quiz-question" 
              class="px-8 py-3 bg-white rounded-xl font-bold text-sm shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all ${isCorrect ? 'text-green-700 border border-green-100' : 'text-red-700 border border-red-100'}"
            >
              ${section.content.currentQuestion < section.content.questions.length - 1 ? 'Next Question' : 'View Results'}
            </button>
        </div>
      </div>
    `;

    // disable options
    this.container.querySelectorAll('.quiz-option').forEach(opt => {
        opt.disabled = true;
        opt.classList.add('opacity-50', 'pointer-events-none');
        
        // Highlight selected
        if(opt.dataset.answer === userAnswer) {
             opt.classList.remove('opacity-50');
             opt.classList.add(isCorrect ? 'border-green-500' : 'border-red-500');
        }
    });
    
    const textArea = this.container.querySelector('#quiz-short-answer');
    if(textArea) {
        textArea.disabled = true;
        textArea.classList.add('opacity-75');
    }
    const submitBtn = this.container.querySelector('#submit-short-answer');
    if(submitBtn) submitBtn.remove();

    // handle next question
    const nextBtn = this.container.querySelector('#next-quiz-question');
    nextBtn.addEventListener('click', () => {
      if (section.content.currentQuestion < section.content.questions.length - 1) {
        section.content.currentQuestion++;
        this.renderSection();
      } else {
        this.showQuizResults();
      }
    });
  }

  /**
   * Show quiz results and enable continue button
   */
  showQuizResults() {
    const section = this.getCurrentSection();
    const score = section.content.score;
    const total = section.content.questions.length;
    const percentage = Math.round((score / total) * 100);

    // Determine message
    let msg = "";
    if (percentage === 100) msg = "Perfect Score! You're a master.";
    else if (percentage >= 70) msg = "Great job! You have a solid grasp.";
    else if (percentage >= 50) msg = "Good start, review the concepts again.";
    else msg = "Keep practicing, you'll get there!";

    this.container.querySelector('.section-content').innerHTML = `
      <div class="glass-panel p-12 rounded-3xl shadow-soft text-center max-w-2xl mx-auto border border-white/60 relative overflow-hidden">
        <div class="absolute inset-0 bg-gradient-to-b from-blue-50/50 to-transparent pointer-events-none"></div>
        
        <div class="relative z-10">
            <div class="w-24 h-24 mx-auto mb-8 rounded-3xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-xl shadow-blue-500/30 transform hover:scale-105 transition-transform duration-500">
              <span class="material-icons-round text-white text-5xl">emoji_events</span>
            </div>
            
            <h3 class="text-3xl font-bold text-gray-900 mb-2 tracking-tight">Quiz Complete!</h3>
            <p class="text-gray-500 font-medium mb-10">${msg}</p>
            
            <div class="bg-gray-50 rounded-2xl p-8 border border-gray-100 mb-8">
                <div class="flex justify-between items-end mb-4">
                     <span class="text-sm font-bold text-gray-400 uppercase tracking-widest">Your Score</span>
                     <span class="text-4xl font-bold text-gray-900">${score}<span class="text-lg text-gray-400 font-medium">/${total}</span></span>
                </div>
                
                <div class="h-4 bg-gray-200 rounded-full overflow-hidden p-0.5">
                    <div class="h-full bg-gradient-to-r from-blue-500 to-indigo-600 rounded-full ease-out transition-all duration-1000 shadow-sm relative overflow-hidden" 
                         style="width: ${percentage}%">
                         <div class="absolute inset-0 bg-white/20 animate-pulse"></div>
                    </div>
                </div>
                <div class="text-right mt-2">
                    <span class="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-md">${percentage}%</span>
                </div>
            </div>
        </div>
      </div>
    `;

    // enable continue button
    section.next_button.enabled = true;
    const continueBtn = this.container.querySelector('#continue-btn');
    if (continueBtn) {
      continueBtn.disabled = false;
      continueBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      continueBtn.innerHTML = `<span>Finish Section</span><span class="material-icons-round">check</span>`;
      continueBtn.classList.remove('from-blue-600', 'to-indigo-600');
      continueBtn.classList.add('from-green-500', 'to-emerald-600', 'shadow-green-500/30');
      
      // Update event listener to just complete
      // Since it's the last section, nextSection() will handle onComplete
      // But we can also change the style to indicate completion
    }
  }

  /**
   * Fade out transition
   */
  fadeOut() {
    return new Promise(resolve => {
      if (!this.container) {
        resolve();
        return;
      }

      this.container.style.transition = 'opacity 0.4s cubic-bezier(0.4, 0, 0.2, 1), transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
      this.container.style.opacity = '0';
      this.container.style.transform = 'translateY(-10px) scale(0.99)';
      
      setTimeout(() => {
        resolve();
      }, 400);
    });
  }

  /**
   * Fade in transition
   */
  fadeIn() {
    return new Promise(resolve => {
      if (!this.container) {
        resolve();
        return;
      }

      this.renderSection();
      
      this.container.style.opacity = '0';
      this.container.style.transform = 'translateY(10px) scale(0.99)';
      
      // trigger reflow
      this.container.offsetHeight;
      
      this.container.style.transition = 'opacity 0.5s cubic-bezier(0, 0, 0.2, 1), transform 0.5s cubic-bezier(0, 0, 0.2, 1)';
      this.container.style.opacity = '1';
      this.container.style.transform = 'translateY(0) scale(1)';
      
      setTimeout(() => {
        resolve();
      }, 500);
    });
  }

  /**
   * Set completion callback
   */
  setOnComplete(callback) {
    this.onComplete = callback;
  }
}
