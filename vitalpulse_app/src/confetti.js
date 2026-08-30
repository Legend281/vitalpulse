/**
 * Lightweight Zero-Dependency Canvas Confetti Engine for VitalPulse
 * High-performance, 60fps particle physics with auto-cleanup.
 */
export function triggerMilestoneConfetti({
  particleCount = 75,
  durationMs = 2800,
  colors = ['#dc2626', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#ffffff']
} = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // Prevent duplicate canvases
  let canvas = document.getElementById('vitalpulseConfettiCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'vitalpulseConfettiCanvas';
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '999999';
    document.body.appendChild(canvas);
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  const particles = [];
  const startX = width / 2;
  const startY = height * 0.65;

  for (let i = 0; i < particleCount; i++) {
    const angle = (Math.PI / 180) * (Math.random() * 130 + 205); // shoot upwards in a fan
    const speed = Math.random() * 15 + 9;
    particles.push({
      x: startX + (Math.random() - 0.5) * 100,
      y: startY,
      vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 6,
      vy: Math.sin(angle) * speed,
      size: Math.random() * 8 + 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 14,
      tilt: Math.random() * 10,
      tiltSpeed: Math.random() * 0.1 + 0.05,
      opacity: 1,
      shape: Math.random() > 0.35 ? 'rect' : 'circle'
    });
  }

  const startTime = performance.now();

  function render(now) {
    const elapsed = now - startTime;
    const progress = elapsed / durationMs;

    ctx.clearRect(0, 0, width, height);

    if (progress >= 1) {
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      return;
    }

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.42; // gravity
      p.vx *= 0.985; // drag
      p.rotation += p.rotationSpeed;
      p.tilt += p.tiltSpeed;
      p.opacity = Math.max(0, 1 - Math.pow(progress, 1.5));

      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.scale(Math.cos(p.tilt), 1);
      ctx.fillStyle = p.color;

      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.75);
      }

      ctx.restore();
    });

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

if (typeof window !== 'undefined') {
  window.triggerMilestoneConfetti = triggerMilestoneConfetti;
}
