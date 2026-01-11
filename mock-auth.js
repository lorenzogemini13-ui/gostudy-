export const auth = { 
    currentUser: { 
        uid: 'test-user', 
        email: 'test@example.com', 
        displayName: 'Test User',
        getIdToken: async () => 'mock-token'
    } 
};
export const API_BASE = 'http://localhost:3000';

export const onAuthStateChanged = (auth, cb) => {
    // Simulate logged in user immediately
    setTimeout(() => cb(auth.currentUser), 100);
    return () => {};
};

// Mock other exports used in index.html
export const signOut = async () => console.log('Mock SignOut');
export const updateProfile = async () => {};
export const updateEmail = async () => {};
export const updatePassword = async () => {};
export const deleteUser = async () => {};
