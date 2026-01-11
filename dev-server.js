const express = require('express');
const path = require('path');
const app = express();

// Serve static files from root
app.use(express.static(path.join(__dirname)));

// Mock Auth Rewrite - MUST BE BEFORE other routes
app.get('/backend/js/auth.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'mock-auth.js'));
});

// Mimic Vercel Rewrites
// Source: /dashboard/:path* -> Destination: /pages/dashboard/:path*
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages/dashboard/index.html'));
});

app.get('/dashboard/*', (req, res) => {
    // Extract the path after /dashboard/
    const subPath = req.params[0];
    
    // Check if it's a file request that actually exists in /pages/dashboard
    // If exact match exists, serve it
    const potentialFile = path.join(__dirname, 'pages/dashboard', subPath);
    
    // If it's a directory or doesn't exist, we might want to fallback to index.html 
    // but for assets/JS imports, we need the file.
    res.sendFile(potentialFile, (err) => {
        if (err) {
            // Fallback to index.html for SPA-like navigation if file not found
            // But usually we want 404 for missing assets
            if (!subPath.includes('.')) {
                 res.sendFile(path.join(__dirname, 'pages/dashboard/index.html'));
            } else {
                res.status(404).send('Not Found');
            }
        }
    });
});

// Other common redirects/rewrites if needed
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'pages/login/index.html')));
app.get('/onboarding', (req, res) => res.sendFile(path.join(__dirname, 'pages/onboarding/index.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'pages/profile/index.html')));

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => {
    console.log(`------------------------------------------------`);
    console.log(`🌐 Frontend Dev Server running at http://localhost:${PORT}`);
    console.log(`👉 Access Dashboard at http://localhost:${PORT}/dashboard`);
    console.log(`------------------------------------------------`);
});
