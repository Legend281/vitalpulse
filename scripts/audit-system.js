const fs = require('fs');
const path = require('path');

function getAllJsFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllJsFiles(fullPath, arrayOfFiles);
    } else if (file.endsWith('.js')) {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

const hospitalHtmlPath = path.join(__dirname, '../vitalpulse_app/hospital.html');
const donorHtmlPath = path.join(__dirname, '../vitalpulse_app/donor.html');
const adminHtmlPath = path.join(__dirname, '../vitalpulse_app/admin.html');
const srcJsFiles = getAllJsFiles(path.join(__dirname, '../vitalpulse_app/src'));

const combinedJsContent = srcJsFiles.map(f => fs.readFileSync(f, 'utf-8')).join('\n');

console.log('=== SYSTEM-WIDE FORM HANDLER AUDIT ===');
function auditHtmlForms(htmlPath, htmlName) {
  if (!fs.existsSync(htmlPath)) return;
  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  console.log(`\n--- Forms in ${htmlName} ---`);
  const forms = htmlContent.match(/<form[^>]*id=["']([^"']+)["']/g) || [];
  forms.forEach(formTag => {
    const idMatch = formTag.match(/id=["']([^"']+)["']/);
    if (idMatch) {
      const formId = idMatch[1];
      const hasHandler = combinedJsContent.includes(formId);
      console.log(`[Form] ${formId}: ${hasHandler ? 'HANDLED ✅' : 'NO HANDLER FOUND ❌'}`);
    }
  });
}

auditHtmlForms(hospitalHtmlPath, 'hospital.html');
auditHtmlForms(donorHtmlPath, 'donor.html');
auditHtmlForms(adminHtmlPath, 'admin.html');

console.log('\n=== BUTTON CLICK LISTENER AUDIT ===');
function auditHtmlButtons(htmlPath, htmlName) {
  if (!fs.existsSync(htmlPath)) return;
  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  console.log(`\n--- Interactive Buttons in ${htmlName} ---`);
  const buttons = htmlContent.match(/<button[^>]*id=["']([^"']+)["']/g) || [];
  buttons.forEach(btnTag => {
    const idMatch = btnTag.match(/id=["']([^"']+)["']/);
    const onclickMatch = btnTag.match(/onclick=["']([^"']+)["']/);
    if (idMatch) {
      const btnId = idMatch[1];
      const hasJsRef = combinedJsContent.includes(btnId);
      const hasInlineClick = !!onclickMatch;
      const isOk = hasJsRef || hasInlineClick;
      console.log(`[Button] ${btnId}: ${isOk ? 'WIRED ✅' : 'UNHANDLED ❌'}`);
    }
  });
}

auditHtmlButtons(hospitalHtmlPath, 'hospital.html');
auditHtmlButtons(donorHtmlPath, 'donor.html');
auditHtmlButtons(adminHtmlPath, 'admin.html');
