var runeImg = ['./img/img_b.jpg', './img/img_c.jpg', './img/img_k.jpg', './img/img_m.jpg', './img/img_o.jpg',
    './img/img_r.jpg', './img/img_s.jpg', './img/img_t.jpg'];

var oldRuneId = "";
var currencyRuneId = "";
var oldBoxId = "";
var currentBoxId = "";

window.onload = function () {
    for (i = 1; i <= 30; i++) {
        Init(i);
    }
}

function Init(id) {
    document.getElementById('img_' + i).src = runeImg[parseInt(1 + Math.random() * 7)];
}

function dragStart(event) {
    oldRuneId = event.target.id;
    oldBoxId = event.target.parentNode.id;
}

function allowDrop(event) {
    event.preventDefault();
}

function drop(event) {
    event.preventDefault();
}

function dragOver(event) {
    allowDrop(event);

    var clone = event.target.cloneNode(true);
    var dtRune = event.dataTransfer.items["rune"];

    if (clone.id != oldRuneId) {
        event.target.parentNode.replaceChild(document.getElementById(oldRuneId), event.target);

        var OriginalBox = document.getElementById(oldBoxId);
        if (OriginalBox.children.length != 0)
            OriginalBox.replaceChild(clone, OriginalBox.firstChild);
        else
            OriginalBox.appendChild(clone);

        var currentBoxId = document.getElementById(oldRuneId).parentNode.id;
        oldBoxId = currentBoxId;
    }
}