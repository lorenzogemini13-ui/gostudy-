const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const fsPromises = require('fs').promises; // Use promises for async safety
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const axios = require('axios');

// --- 1. CONFIGURATION & VALIDATION ---
if (!process.env.PERPLEXITY_API_KEY) {
    console.error("CRITICAL ERROR: process.env.PERPLEXITY_API_KEY is missing.");
    process.exit(1);
}

const app = express();

// --- 2. SECURITY & LIMITS ---
// Allow all origins (dev) or restrict in production
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Limit upload size to 5MB to prevent memory exhaustion
const upload = multer({ 
    dest: '/tmp/',
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// --- 3. HELPER FUNCTIONS ---

// Safely delete file without crashing if it's already gone
const safeDelete = async (path) => {
    try {
        await fsPromises.unlink(path);
    } catch (err) {
        // Ignore "file not found" errors, log others
        if (err.code !== 'ENOENT') console.error(`Failed to delete temp file ${path}:`, err.message);
    }
};

// Robust text extraction with guaranteed cleanup
const extractText = async (file) => {
    const filePath = file.path;
    let extractedText = '';
    
    try {
        const buffer = await fsPromises.readFile(filePath);

        if (file.mimetype === 'application/pdf') {
            const data = await pdf(buffer);
            extractedText = data.text;
        } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ path: filePath });
            extractedText = result.value;
        } else if (file.mimetype === 'text/plain') {
            extractedText = buffer.toString('utf-8');
        } else {
            throw new Error('Unsupported file type. Must be PDF, DOCX, or TXT.');
        }
        
        return extractedText;
    } finally {
        // CLEANUP: Guaranteed to run after extraction attempt
        await safeDelete(filePath);
    }
};

// --- 4. API ROUTE ---

app.post('/api/generate-plan', upload.single('document'), async (req, res) => {
    // 1. Validation
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded or file too large (>5MB).' });
    }

    console.log(`\n--- Processing: ${req.file.originalname} ---`);

    try {
        // 2. Extraction
        let documentText = await extractText(req.file);
        
        // Remove non-printable characters
        documentText = documentText.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, '');

        if (!documentText || documentText.trim().length < 50) {
            throw new Error("Document text is empty or too short. If this is a scanned PDF, please use OCR.");
        }

        console.log(`Extracted ${documentText.length} characters.`);

        // 3. Truncation (Safe Token Limits)
        // Approx 15k tokens to leave room for the answer
        const truncatedText = documentText.substring(0, 60000); 

        // 4. Optimized System Prompt (v2 - Strict Conciseness)
        const systemPrompt = `You are an expert AI Study Assistant.
Analyze the provided text and generate a structured study plan in JSON format.

GOALS:
1. SUMMARY: Provide a high-density executive summary (MAX 80 words).
2. ACTIVE RECALL: Generate 3-5 high-yield questions. 
   - Answers MUST be extremely concise (MAX 2 sentences per answer).
3. SPACED REPETITION: Create a 4-step schedule (Day 1, 3, 7, 14).
4. MEMORY PALACE: Describe a vivid spatial mnemonic for the single most complex concept (MAX 100 words).

CONSTRAINTS:
- Use valid JSON only.
- Follow the snake_case schema exactly.
- NO preambles or explanations.
- BE CONCISE. Every word must add value.

SCHEMA:
{
  "summary": "string",
  "active_recall": [{"question": "string", "answer": "string"}],
  "spaced_repetition": [{"day": "string", "topic": "string"}],
  "memory_palace": "string"
}`;

        console.log('Sending to Perplexity AI...');
        
        const response = await axios.post('https://api.perplexity.ai/chat/completions', {
            model: 'sonar-pro', 
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze this material and generate the study plan accordingly:\n\n${truncatedText}` }
            ],
            temperature: 0.2,
            max_tokens: 3000
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        // 5. Robust JSON Parsing
        let content = response.data.choices[0].message.content;
        
        // Remove markdown code blocks if present
        content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        
        // Extract JSON object if AI includes preamble text
        let jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            content = jsonMatch[0];
        }

        let studyPlan;
        try {
            studyPlan = JSON.parse(content);
            
            // Validate required fields
            if (!studyPlan.summary || !studyPlan.active_recall || !studyPlan.spaced_repetition || !studyPlan.memory_palace) {
                throw new Error('Invalid response structure: missing required fields');
            }
        } catch (jsonError) {
            console.error("JSON Parse Error. AI Output:", content);
            throw new Error("AI response was invalid. Please try again.");
        }

        console.log('✅ Plan generated successfully!');
        res.json(studyPlan);

    } catch (error) {
        console.error('❌ Error details:', error);
        console.error('Stack:', error.stack);
        
        // Handle specific Axios errors (API limits, auth)
        if (error.response) {
            console.error('API Response Status:', error.response.status);
            console.error('API Response Data:', error.response.data);
            return res.status(error.response.status).json({ 
                error: 'AI Provider Error', 
                details: error.response.data,
                message: error.message
            });
        }

        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`------------------------------------------------`);
    console.log(`🚀 GoStudy Backend running on port ${PORT}`);
    console.log(`------------------------------------------------`);
});