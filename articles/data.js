
export const articles = [
  {
    id: 1,
    title: "The Forgetting Curve: Why You Lose 80% of What You Read",
    category: "Science",
    date: "Oct 12, 2025",
    author: "Dr. Hermann Ebbinghaus",
    readingTime: "5 min read",
    image: "https://images.unsplash.com/photo-1532012197267-da84d127e765?auto=format&fit=crop&w=800&q=80",
    intro: "Hermann Ebbinghaus discovered that memory decay is exponential. Here is the mathematical formula to stop it.",
    content: `
      <h3 class="text-2xl font-bold mb-4">The Mathematics of Memory</h3>
      <p class="mb-4">In 1885, Hermann Ebbinghaus hypothesized that the speed of forgetting depends on a number of factors such as the difficulty of the learned material (e.g., how meaningful it is), its representation, and physiological factors such as stress and sleep. He concluded that the difference between the difficulty of the material significantly affects the speed of forgetting.</p>
      
      <h3 class="text-2xl font-bold mb-4">How to Beat the Curve</h3>
      <p class="mb-4">The best way to combat the forgetting curve is through <strong>Spaced Repetition</strong>. By reviewing information at increasing intervals, you can flatten the curve and retain information for much longer.</p>
      
      <ul class="list-disc pl-6 mb-6 space-y-2">
        <li><strong>Review 1:</strong> Immediately after learning (100% retention)</li>
        <li><strong>Review 2:</strong> 24 hours later</li>
        <li><strong>Review 3:</strong> 1 week later</li>
        <li><strong>Review 4:</strong> 1 month later</li>
      </ul>

      <p class="mb-4">This technique forces your brain to reconstruct the memory, strengthening the neural pathways associated with it.</p>
    `
  },
  {
    id: 2,
    title: "Active Recall: The High-Performance Student's Secret",
    category: "Technique",
    date: "Oct 08, 2025",
    author: "Ali Abdaal",
    readingTime: "7 min read",
    image: "https://images.unsplash.com/photo-1434030216411-0b793f4b4173?auto=format&fit=crop&w=800&q=80",
    intro: "Stop highlighting. It feels like work, but it's not learning. Discover why testing yourself is 3x more effective.",
    content: `
      <h3 class="text-2xl font-bold mb-4">The Illusion of Competence</h3>
      <p class="mb-4">When you re-read a textbook or highlight passages, you are recognizing information, not retrieving it. This creates an illusion of competence. You feel like you know it because the text looks familiar.</p>

      <h3 class="text-2xl font-bold mb-4">What is Active Recall?</h3>
      <p class="mb-4">Active recall involves closing the book and asking yourself, "What did I just read?" It requires effort. That cognitive strain is exactly what signals your brain that this information is important.</p>

      <div class="bg-blue-50 p-6 rounded-xl border-l-4 border-blue-500 mb-6">
        <p class="italic text-blue-800">"The more effort it takes to retrieve a memory, the more that retrieval strengthens the memory."</p>
      </div>

      <h3 class="text-2xl font-bold mb-4">Implementation Strategies</h3>
      <ol class="list-decimal pl-6 mb-6 space-y-2">
        <li><strong>The SQ3R Method:</strong> Survey, Question, Read, Recite, Review.</li>
        <li><strong>Flashcards:</strong> Use tools like Anki to automate the process.</li>
        <li><strong>The Feynman Technique:</strong> Try to explain the concept to a 5-year-old.</li>
      </ol>
    `
  },
  {
    id: 3,
    title: "Deep Work: Rules for Focused Success",
    category: "Productivity",
    date: "Sep 29, 2025",
    author: "Cal Newport",
    readingTime: "10 min read",
    image: "https://images.unsplash.com/photo-1456324504439-367cee3b3c32?auto=format&fit=crop&w=800&q=80",
    intro: "In a distracted world, the ability to focus without distraction is a superpower. Here is how to cultivate it.",
    content: `
      <h3 class="text-2xl font-bold mb-4">The Shallow Work Epidemic</h3>
      <p class="mb-4">Most people spend their days in a state of "continuous partial attention." Checking emails, Slack messages, and notifications every 10 minutes prevents you from entering a flow state.</p>

      <h3 class="text-2xl font-bold mb-4">The 4 Rules of Deep Work</h3>
      <p class="mb-4">Deep work is the ability to focus without distraction on a cognitively demanding task. It's a skill that allows you to quickly master complicated information and produce better results in less time.</p>

      <ul class="list-disc pl-6 mb-6 space-y-2">
        <li><strong>Rule 1:</strong> Work Deeply. Schedule 90-minute blocks of uninterrupted time.</li>
        <li><strong>Rule 2:</strong> Embrace Boredom. Don't pull out your phone the moment you're waiting in line.</li>
        <li><strong>Rule 3:</strong> Quit Social Media. Unless it's vital for your career, it's a net negative.</li>
        <li><strong>Rule 4:</strong> Drain the Shallows. Minimize logistical/admin work.</li>
      </ul>
    `
  },
  {
    id: 4,
    title: "Exam Anxiety is Biological: How to Hack It",
    category: "Mental Health",
    date: "Sep 15, 2025",
    author: "Dr. Andrew Huberman",
    readingTime: "6 min read",
    image: "https://images.unsplash.com/photo-1493836512294-502baa1986e2?auto=format&fit=crop&w=800&q=80",
    intro: "Your cortisol levels spike before a test. Here are 3 breathing exercises to hijack your nervous system immediately.",
    content: `
      <h3 class="text-2xl font-bold mb-4">The Sympathetic Nervous System</h3>
      <p class="mb-4">When you're anxious, your body enters "fight or flight" mode. Blood leaves your prefrontal cortex (responsible for logic) and goes to your muscles. This is why you "blank out" during exams.</p>

      <h3 class="text-2xl font-bold mb-4">The Physiological Sigh</h3>
      <p class="mb-4">This is the fastest way to reduce autonomic arousal in real-time. It offloads carbon dioxide and slows the heart rate.</p>

      <div class="bg-gray-100 p-6 rounded-xl mb-6">
        <h4 class="font-bold mb-2">How to do it:</h4>
        <ol class="list-decimal pl-6 space-y-1">
          <li>Two short inhales through the nose (fully inflate the lungs).</li>
          <li>One long exhale through the mouth (until lungs are empty).</li>
          <li>Repeat 2-3 times.</li>
        </ol>
      </div>

      <p class="mb-4">Use this whenever you feel your heart racing before or during a study session.</p>
    `
  },
  {
    id: 5,
    title: "The Feynman Technique: Master Any Subject",
    category: "Technique",
    date: "Sep 01, 2025",
    author: "Richard Feynman",
    readingTime: "8 min read",
    image: "https://images.unsplash.com/photo-1516979187457-637abb4f9353?auto=format&fit=crop&w=800&q=80",
    intro: "If you can't explain it simply, you don't understand it well enough. The ultimate mental model for learning.",
    content: `
      <h3 class="text-2xl font-bold mb-4">Complexity is the Enemy</h3>
      <p class="mb-4">Richard Feynman, a Nobel prize-winning physicist, was known as the "Great Explainer." He believed that jargon often hides a lack of understanding.</p>

      <h3 class="text-2xl font-bold mb-4">The 4 Steps</h3>
      <ol class="list-decimal pl-6 mb-6 space-y-4">
        <li>
          <strong>Choose a Concept:</strong> Write the name of the concept at the top of a blank sheet of paper.
        </li>
        <li>
          <strong>Teach it to a Child:</strong> Write an explanation in simple language. Avoid technical terms. Use analogies.
        </li>
        <li>
          <strong>Identify Gaps:</strong> If you get stuck, go back to the source material. This is where the learning happens.
        </li>
        <li>
          <strong>Simplify and Organize:</strong> Streamline your explanation and create a narrative.
        </li>
      </ol>
    `
  },
  {
    id: 6,
    title: "Dopamine Detox: Reset Your Focus",
    category: "Productivity",
    date: "Aug 20, 2025",
    author: "Dr. Anna Lembke",
    readingTime: "12 min read",
    image: "https://images.unsplash.com/photo-1517960413843-0aee8e2b3285?auto=format&fit=crop&w=800&q=80",
    intro: "Why you can't stop scrolling and how to reset your brain's reward system for maximum motivation.",
    content: `
      <h3 class="text-2xl font-bold mb-4">The Pleasure-Pain Balance</h3>
      <p class="mb-4">In her book <em>Dopamine Nation</em>, Dr. Lembke explains that pleasure and pain are processed in the same part of the brain and work like a balance.</p>
      
      <p class="mb-4">When you over-indulge in high-dopamine activities (social media, video games, sugar), the balance tips to the side of pleasure. But the brain constantly seeks homeostasis, so it tips the balance hard to the side of pain (boredom, anxiety, lack of motivation) to compensate.</p>

      <h3 class="text-2xl font-bold mb-4">How to Reset</h3>
      <ul class="list-disc pl-6 mb-6 space-y-2">
        <li><strong>The 30-Day Reset:</strong> Abstain from your drug of choice for 4 weeks.</li>
        <li><strong>Self-Binding:</strong> Create physical barriers between you and the temptation.</li>
        <li><strong>Honest Truth:</strong> Stop lying to yourself about your consumption habits.</li>
      </ul>
      
      <p>After the reset, you will find that "boring" tasks like studying become more interesting because your baseline dopamine levels have restored.</p>
    `
  }
];
