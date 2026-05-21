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
        
        // Check if the script is already included
        if (!content.includes('<script type="module" src="/src/main.js"></script>')) {
            // Append right before closing body tag
            content = content.replace('</body>', '<script type="module" src="/src/main.js"></script>\n</body>');
            fs.writeFileSync(filePath, content);
            console.log(`Injected script into ${filename}`);
        } else {
            console.log(`${filename} already has the script.`);
        }
    }
}
