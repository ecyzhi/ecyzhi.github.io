var runeImg = ['./img/img_b.jpg', './img/img_c.jpg', './img/img_k.jpg', './img/img_m.jpg', './img/img_o.jpg',
    './img/img_r.jpg', './img/img_s.jpg', './img/img_t.jpg'];

function Init(id) {
    document.getElementById('img_' + id).onload = null;
    document.getElementById('img_' + id).src = runeImg[parseInt(1 + Math.random() * 7)];
}