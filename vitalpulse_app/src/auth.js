import { 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    updateProfile
} from "firebase/auth";
import { doc, setDoc, getDoc, updateDoc } from "firebase/firestore";
import { auth, db } from './firebase';

export async function registerUser(email, password, role, additionalData) {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        await updateProfile(user, { displayName: additionalData.name });
        
        await setDoc(doc(db, 'users', user.uid), {
            email,
            role,
            name: additionalData.name,
            bloodType: additionalData.bloodType || null,
            city: additionalData.city || null,
            phone: additionalData.phone || null,
            licenseUrl: additionalData.licenseUrl || null,
            isVerified: role === 'donor' ? true : false,
            createdAt: new Date().toISOString()
        });
        
        const newUser = { uid: user.uid, email, role, ...additionalData };
        localStorage.setItem('vitalpulse_user', JSON.stringify(newUser));
        return newUser;
    } catch (error) {
        console.error("Registration error:", error);
        throw error;
    }
}

export async function loginUser(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        let role = 'donor';
        const userEmail = user.email.toLowerCase();
        let userData = {};
        
        // Gracefully handle Firestore permission errors
        try {
            const userDocRef = doc(db, 'users', user.uid);
            const userDoc = await getDoc(userDocRef);
            
            if (userDoc.exists()) {
                userData = userDoc.data();
                role = userData.role || role;
            }
        } catch (firestoreError) {
            console.warn("Firestore read failed (rules may be locked), falling back to email-based role:", firestoreError);
        }
        
        // Check for special admin email
        if (userEmail === 'admin@vitalpulse.cm' || userEmail === 'admin@vitalpulse.com') {
            role = 'admin';
        }
        
        const fullUser = {
            uid: user.uid,
            email: user.email,
            name: user.displayName || email.split('@')[0],
            role,
            ...userData
        };
        localStorage.setItem('vitalpulse_user', JSON.stringify(fullUser));
        return fullUser;
    } catch (error) {
        console.error("Login error:", error);
        throw error;
    }
}

export async function logoutUser() {
    try {
        await signOut(auth);
        localStorage.removeItem('vitalpulse_user');
        window.location.href = '/login.html';
    } catch (error) {
        console.error("Logout error:", error);
    }
}

export function onAuthChange(callback) {
    return onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            const userData = userDoc.exists() ? userDoc.data() : { role: 'donor' };
            currentUser = { uid: user.uid, email: user.email, ...userData };
            localStorage.setItem('vitalpulse_user', JSON.stringify(currentUser));
            callback(currentUser);
        } else {
            currentUser = null;
            localStorage.removeItem('vitalpulse_user');
            callback(null);
        }
    });
}

export function getCurrentUser() {
    const stored = localStorage.getItem('vitalpulse_user');
    return stored ? JSON.parse(stored) : null;
}