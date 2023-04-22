// Close the navbar when a link is clicked
// const navLinks = document.querySelectorAll('.nav-item')
// const menuToggle = document.getElementById('navbarColor01')
// const bsCollapse = new bootstrap.Collapse(menuToggle)
// navLinks.forEach((l) => {
//     l.addEventListener('click', () => { bsCollapse.toggle() })
// })

function animateOnScroll() {
    const fadeInElements = document.querySelectorAll("p, h1, h5");

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            // Get the index of the element in the parent node and delay the animation so that it appears one after the other
            const children = Array.from(entry.target.parentNode.children);
            let delay = children.indexOf(entry.target) * 0.2;

            if (entry.isIntersecting) {
                entry.target.classList.add('animate__animated', 'animate__fadeIn');
                entry.target.style.animationDelay = `${delay}s`;
            }
        });
    });

    fadeInElements.forEach((el) => observer.observe(el));
}

animateOnScroll();