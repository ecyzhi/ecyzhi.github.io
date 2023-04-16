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