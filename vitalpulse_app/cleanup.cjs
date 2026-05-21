const fs = require('fs');
const path = require('path');

const filesToClean = [
    'index.html',
    'login.html',
    'signup.html',
    'donor.html',
    'hospital.html',
    'admin.html'
];

for (const filename of filesToClean) {
    const filePath = path.join(__dirname, filename);
    if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf8');
        
        // Remove the CDN script
        content = content.replace(/<script src="https:\/\/cdn\.tailwindcss\.com\?plugins=forms,container-queries"><\/script>/g, '');
        
        // Remove the inline tailwind config (from <script id="tailwind-config"> to its closing tag)
        content = content.replace(/<script id="tailwind-config">[\s\S]*?<\/script>/g, '');
        
        // Remove inline style blocks since we are using src/style.css
        content = content.replace(/<style>[\s\S]*?<\/style>/g, '');
        
        fs.writeFileSync(filePath, content);
        console.log(`Cleaned ${filename}`);
    }
}
