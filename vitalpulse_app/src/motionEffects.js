// ============================================================================
// VITALPULSE MOTION & SPRING ANIMATION CONTROLLER (src/motionEffects.js)
//
// Powered by 'motion' (Framer Motion's official vanilla JS spring animation engine).
// Delivers Apple/Stripe-tier spring physics, scroll-triggered reveals,
// micro-interactions, and reactive UI transitions.
// ============================================================================

import { animate, inView, stagger } from 'motion';

export function initMotionEffects() {
    // Check for reduced motion preference
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.querySelectorAll('.reveal').forEach(el => el.classList.add('revealed'));
        return;
    }

    // 1. Hero Stagger Entrance Animation (Spring-driven)
    initHeroEntrance();

    // 2. Scroll-Triggered Section Reveals (Framer Motion inView)
    initScrollReveals();

    // 3. Interactive Blood Matrix Reactive Animation Hook
    initMatrixMotionHooks();

    // 4. Smooth Hover Interactions on Cards & Badges
    initCardMicroMotion();
}

function initHeroEntrance() {
    const heroElements = document.querySelectorAll('#heroContent > *');
    if (heroElements.length > 0) {
        animate(
            heroElements,
            {
                opacity: [0, 1],
                y: [28, 0],
                scale: [0.98, 1]
            },
            {
                delay: stagger(0.09, { start: 0.15 }),
                duration: 0.85,
                easing: [0.16, 1, 0.3, 1]
            }
        );
    }
}

function initScrollReveals() {
    // Animate sections and cards as they enter viewport
    const revealTargets = document.querySelectorAll('.reveal');
    revealTargets.forEach(el => {
        inView(
            el,
            () => {
                animate(
                    el,
                    {
                        opacity: [0, 1],
                        y: [24, 0]
                    },
                    {
                        duration: 0.75,
                        easing: [0.16, 1, 0.3, 1]
                    }
                );
                el.classList.add('revealed');
            },
            { margin: '0px 0px -40px 0px' }
        );
    });

    // Stagger animation for the Telemetry Ribbon
    const telemetryItems = document.querySelectorAll('.telemetry-card');
    if (telemetryItems.length > 0) {
        inView(
            telemetryItems[0].parentElement,
            () => {
                animate(
                    telemetryItems,
                    {
                        opacity: [0, 1],
                        y: [20, 0],
                        scale: [0.96, 1]
                    },
                    {
                        delay: stagger(0.08),
                        duration: 0.7,
                        easing: [0.16, 1, 0.3, 1]
                    }
                );
            },
            { margin: '0px 0px -30px 0px' }
        );
    }

    // Stagger animation for the 6-Step Clinical Pipeline
    const workflowSteps = document.querySelectorAll('.workflow-step-card');
    if (workflowSteps.length > 0) {
        inView(
            workflowSteps[0].parentElement,
            () => {
                animate(
                    workflowSteps,
                    {
                        opacity: [0, 1],
                        y: [22, 0]
                    },
                    {
                        delay: stagger(0.07),
                        duration: 0.65,
                        easing: [0.16, 1, 0.3, 1]
                    }
                );
            },
            { margin: '0px 0px -50px 0px' }
        );
    }
}

function initMatrixMotionHooks() {
    // Expose a function that animates the matrix display card whenever a blood pill is clicked
    window.animateMatrixChange = () => {
        const displayCard = document.getElementById('matrixSelectedType');
        if (displayCard) {
            animate(
                displayCard,
                {
                    scale: [0.88, 1.08, 1],
                    rotate: [-3, 2, 0]
                },
                {
                    duration: 0.45,
                    easing: [0.16, 1, 0.3, 1]
                }
            );
        }

        const badges = document.querySelectorAll('#matrixGiveToList > div, #matrixReceiveFromList > div');
        if (badges.length > 0) {
            animate(
                badges,
                {
                    opacity: [0.4, 1],
                    scale: [0.92, 1]
                },
                {
                    delay: stagger(0.02),
                    duration: 0.35,
                    easing: [0.16, 1, 0.3, 1]
                }
            );
        }
    };
}

function initCardMicroMotion() {
    // Add subtle spring bounce to primary action buttons on click
    document.querySelectorAll('.btn-spring').forEach(btn => {
        btn.addEventListener('mousedown', () => {
            animate(btn, { scale: 0.96 }, { duration: 0.12 });
        });
        btn.addEventListener('mouseup', () => {
            animate(btn, { scale: 1 }, { duration: 0.25, easing: [0.16, 1, 0.3, 1] });
        });
        btn.addEventListener('mouseleave', () => {
            animate(btn, { scale: 1 }, { duration: 0.25 });
        });
    });
}
