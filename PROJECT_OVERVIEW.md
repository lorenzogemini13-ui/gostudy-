# GoStudy! Project Overview

GoStudy! is an intelligent learning platform that transforms static study materials into active, science-backed study plans using AI.

##  Technology Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | HTML5, Vanilla JavaScript, Tailwind CSS |
| **Icons & Fonts** | Material Icons Round, Google Fonts (Inter, JetBrains Mono) |
| **Backend** | Node.js, Express.js |
| **AI Engine** | Perplexity AI (`sonar` model) |
| **Authentication** | Firebase Authentication (Google & Email/Password) |
| **Database** | Google Cloud Firestore |
| **Payments** | PayPal Subscriptions API |
| **File Processing** | Multer, PDF-parse, Mammoth (DOCX) |
| **Hosting** | Vercel (Frontend), Render (Backend) |

---

##  Core Features

### 1. AI Study Plan Generation
Upload PDF, DOCX, or TXT files to generate:
- **High-Density Summary**: Core concepts distilled with bold key terms
- **Concept Map**: Visual hierarchical tree with main topic and branching subtopics
- **Active Recall Quizzes**: 5 questions with difficulty ratings (1-5 stars)
- **Spaced Repetition Schedule**: 4-step plan (Day 1, 3, 7, 14) with hints
- **Memory Palace**: Spatial mnemonics for complex topics with 3D mode preview

### 2. Production-Safe Credits System
- **Balance-Based**: Integer credits instead of monthly counters
- **Atomic Transactions**: Firestore transactions prevent race conditions
- **Audit Trail**: Append-only `credits_ledger` logs all changes
- **Idempotency**: Duplicate operations are rejected
- **Plan Limits**: Free (3 lifetime credits), Pro (40 credits/month @ $12.99)

### 3. PayPal Integration
- **Webhook Verification**: Signature verified via PayPal API
- **Idempotent Processing**: `processed_webhooks` prevents duplicates
- **Refund Handling**: Credits subtracted on `PAYMENT.SALE.REFUNDED`
- **Polling-Based Confirmation**: Frontend waits for webhook processing

### 4. User Dashboard
- **File Upload**: Up to 5MB per file (PDF, DOCX, TXT)
- **Visual Concept Map**: Tree-style diagram with main topic and subtopics
- **Credits Display**: Real-time balance with progress bar
- **Study History**: Previous plans stored in Firestore
- **Limit Handling**: Pro upgrade CTA when credits exhausted

### 5. Account & Profile Management
- **Multi-method Auth**: Google Social Login + Email/Password
- **Profile Customization**: Display name and profile pictures
- **Subscription Status**: Current plan and usage stats
- **Secure Actions**: Password updates and account deletion

---

##  Site Map


    Home["/ (Landing Page)"] --> Login["/login/"]
    Home --> Articles["/articles/ (Blog)"]
    Home --> Pricing["/pricing/"]
    
    Login --> Onboarding["/onboarding/"]
    Onboarding --> Dashboard["/dashboard/"]
    
    Dashboard --> Profile["/profile/"]
    Dashboard --> GenPlan["/api/generate-plan"]
    
    Pricing --> Pro["/pricing/pro/ (PayPal)"]
    
    subgraph Informational
        About["/about/"]
        Contact["/contact/"]
        HowItWorks["/how-it-works/"]
        Methodology["/methodology/"]


---

##  Architecture

### Authentication Flow
1. **Client**: Authenticates via Firebase SDK
2. **Requests**: Attaches `Authorization: Bearer <token>` header
3. **Backend**: Middleware uses `firebase-admin.verifyIdToken()`

### Credits System Flow
1. **User Action**: Triggers `/api/generate-plan`
2. **Middleware**: `checkCredits` verifies balance > 0
3. **Deduction**: `deductCredits()` runs atomic Firestore transaction
4. **Ledger**: Entry added to `credits_ledger` with idempotency key
5. **Response**: Plan returned, balance updated in UI

### PayPal Webhook Flow
1. **Webhook Received**: PayPal posts to `/api/paypal/webhook`
2. **Signature Verified**: Via PayPal `/v1/notifications/verify-webhook-signature`
3. **Idempotency Check**: Event ID looked up in `processed_webhooks`
4. **Credits Added**: `addCredits()` with atomic transaction
5. **Event Logged**: Stored in `processed_webhooks`

### Plan Generation Pipeline
1. **Upload**: `multer` saves to `/tmp/` (5MB limit)
2. **Extraction**: `pdf-parse` or `mammoth` extracts text
3. **AI Request**: Sent to Perplexity AI with JSON system prompt
4. **Response Processing**: Validates and normalizes concept map structure
5. **Persistence**: Saved to Firestore + disk (`saved_plans/`)
6. **Credit Deduction**: Atomic transaction with ledger entry

---

## File Structure


backend/
├── server.js          # Express server, API routes, credits system
├── js/auth.js         # Client-side Firebase + API constants
└── saved_plans/       # Generated study plans (per user)

dashboard/             # Upload UI, credits display, study plans
pricing/               # Tier details + PayPal integration
  └── pro/             # Pro subscription with PayPal button
profile/               # Account settings, subscription status
articles/              # Blog content
methodology/           # Science-backed approach explanation
onboarding/            # New user flow
assets/                # Global images and branding


---

##  Security Features

- **Firebase ID Token Verification**: All authenticated routes
- **PayPal Webhook Signature**: Prevents spoofed events
- **Idempotency Keys**: Prevents duplicate transactions
- **Atomic Firestore Transactions**: Prevents race conditions
- **Credits Ledger**: Complete audit trail for compliance

---

##  Environment Variables

PERPLEXITY_API_KEY=xxx
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
PAYPAL_CLIENT_ID=xxx
PAYPAL_CLIENT_SECRET=xxx
PAYPAL_WEBHOOK_ID=xxx
NODE_ENV=production

