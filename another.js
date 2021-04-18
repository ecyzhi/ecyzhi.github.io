var runeImg = ['./img/img_b.jpg', './img/img_c.jpg', './img/img_k.jpg', './img/img_m.jpg', './img/img_o.jpg',
    './img/img_r.jpg', './img/img_s.jpg', './img/img_t.jpg'];

window.onload = function () {
    for (i = 1; i <= 30; i++) {
        Init(i);
    }
}

function Init(id) {
    document.getElementById('img_' + i).src = runeImg[parseInt(1 + Math.random() * 7)];
}

function dragStart(event) {
    event.dataTransfer.setData("Rune", event.target.id);
    event.dataTransfer.setData("OriginalBox", event.target.parentNode.id);
}

function allowDrop(event) {
    event.preventDefault();
}

function drop(event) {
    event.preventDefault();
    var clone = event.target.cloneNode(true);
    var data = event.dataTransfer.getData("Rune");
    var OriginalBox = event.dataTransfer.getData("OriginalBox");
    event.target.parentNode.replaceChild(document.getElementById(data), event.target);
    document.getElementById(OriginalBox).appendChild(clone);
}