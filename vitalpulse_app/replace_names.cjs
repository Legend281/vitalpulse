const fs = require('fs');
const path = require('path');

const filesToUpdate = [
    'index.html',
    'login.html',
    'signup.html',
    'donor.html',
    'hospital.html',
    'admin.html'
];

for (const filename of filesToUpdate) {
    const filePath = path.join(__dirname, filename);
    if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf8');
        
        // Replace Vitalis with VitalPulse
        content = content.replace(/Vitalis/g, 'VitalPulse');
        content = content.replace(/vitalis\.cm/g, 'vitalpulse.cm');
        
        // Update login link
        content = content.replace(/<a[^>]*href="#"[^>]*>Create an account<\/a>/g, '<a class="text-primary font-bold hover:underline underline-offset-4 ml-1" href="signup.html">Create an account</a>');
        
        // Update signup to login link
        content = content.replace(/<button class="text-primary font-bold text-sm px-4 py-2 hover:bg-surface-container-low rounded-lg transition-all">Login<\/button>/g, '<a href="login.html" class="text-primary font-bold text-sm px-4 py-2 hover:bg-surface-container-low rounded-lg transition-all inline-block">Login</a>');
        
        fs.writeFileSync(filePath, content);
        console.log(`Updated ${filename}`);
    }
}
