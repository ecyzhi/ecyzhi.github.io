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
// const navbar = document.querySelector(".navbar");

// window.addEventListener('scroll', () => {
//     if (window.scrollY >= 56) {
//         navbar.classList.add("navbar-scrolled");
//     } else {
//         navbar.classList.remove("navbar-scrolled");
//     }
// });

const navbar = document.querySelector("header");

window.addEventListener('scroll', () => {
    if (window.scrollY >= 56) {
        navbar.classList.add("navbar-scrolled");
    } else {
        navbar.classList.remove("navbar-scrolled");
    }
});