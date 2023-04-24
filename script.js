// Mobile Side Navigation
function openNav(event) {
    event.preventDefault();
    document.querySelector(".sidenav").style.width = "100%";
}

function closeNav(event) {
    event.preventDefault();
    document.querySelector(".sidenav").style.width = "0";
}

const menuNav = document.querySelector(".menu-nav");
menuNav.addEventListener('click', e => openNav(e));

const closeBtn = document.querySelector(".closebtn");
closeBtn.addEventListener('click', e => closeNav(e));

const menuItems = document.querySelectorAll(".menu-item > a");
for (let menuItem of menuItems) {
    menuItem.addEventListener('click', e => { document.querySelector(".sidenav").style.width = "0"; });
}

// Contact Form Dialog
function showDialog() {
    var dialog = document.querySelector('.dialog');
    dialog.style.display = 'flex';
}

function hideDialog() {
    var dialog = document.querySelector('.dialog');
    dialog.style.display = 'none';
}

const form = document.querySelector(".contact-form");
form.addEventListener('submit', e => {
    e.preventDefault();
    showDialog();
    form.submit();
});

const closeDialogBtn = document.querySelector(".dialog-button .primary-btn");
closeDialogBtn.addEventListener('click', e => {
    hideDialog();
    form.reset();
});

// Navbar change from transparent to solid color on scroll
const navbar = document.querySelector("header");
window.addEventListener('scroll', () => {
    if (window.scrollY >= 56) {
        navbar.classList.add("navbar-scrolled");
    } else {
        navbar.classList.remove("navbar-scrolled");
    }
});

// // Works box mouseover effect
// const works = document.querySelectorAll(".works-box");
// works.forEach(work => {
//     let pText = work.querySelector("p").innerText;
//     work.addEventListener('mouseover', () => {
//         work.querySelector("p").innerText = "Go To Website";
//     });
//     work.addEventListener('mouseout', () => {
//         work.querySelector("p").innerText = pText;
//     });
// });

// Animate on scroll
function animateOnScroll() {
    const fadeInElements = document.querySelectorAll(".fade-in, .fade-down, .fade-up, .fade-left");

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            // Get the index of the element in the parent node and delay the animation so that it appears one after the other
            const children = Array.from(entry.target.parentNode.children);
            let delay = children.indexOf(entry.target) * 0.2;

            if (entry.isIntersecting) {
                if (entry.target.className.includes('fade-in')) {
                    entry.target.classList.add('animate__animated', 'animate__fadeIn');
                } else if (entry.target.className.includes('fade-down')) {
                    entry.target.classList.add('animate__animated', 'animate__fadeInDown');
                } else if (entry.target.className.includes('fade-up')) {
                    entry.target.classList.add('animate__animated', 'animate__fadeInUp');
                } else if (entry.target.className.includes('fade-left')) {
                    entry.target.classList.add('animate__animated', 'animate__fadeInLeft');
                }

                if (entry.target.className.includes('no-delay')) {
                    entry.target.style.animationDelay = `0s`;
                } else {
                    entry.target.style.animationDelay = `${delay}s`;
                }
            }
        });
    });

    fadeInElements.forEach((el) => observer.observe(el));
}

animateOnScroll();