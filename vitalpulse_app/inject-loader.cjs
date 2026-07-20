const fs = require('fs');
const path = require('path');

const files = [
  'about.html', 'admin.html', 'donor.html',
  'hospital.html', 'index.html', 'login.html', 'signup.html'
];

const headStyle = `
<style>
  #global-loader {
    position: fixed;
    inset: 0;
    z-index: 99999;
    background-color: #f8fafc;
    display: flex;
    justify-content: center;
    align-items: center;
    transition: opacity 0.4s ease;
  }
  .loader-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(220, 38, 38, 0.2);
    border-top-color: #dc2626;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>`;

const bodyLoader = `
<div id="global-loader"><div class="loader-spinner"></div></div>
`;

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Prevent double injection
  if (content.includes('id="global-loader"')) {
    console.log(`Skipped ${file}`);
    return;
  }

  // Inject into head
  content = content.replace('</head>', headStyle);

  // Inject into body (first opening tag)
  content = content.replace(/(<body[^>]*>)/, `$1${bodyLoader}`);

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${file}`);
});
