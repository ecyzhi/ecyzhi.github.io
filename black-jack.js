var cardNumber = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
var cardSuit = ["&spades;", "&hearts;", "&clubs;", "&diams;"];
var dealerCard = [];
var dealerCardNum = 0;
var dealerCardValue = [];
var playerCard = [];
var playerCardNum = 0;
var playerCardValue = [];

var end = false;

async function deal() {
    var randomCard;

    dealCard("Player");
    await new Promise(r => setTimeout(r, 500));
    dealCard("Dealer");
    await new Promise(r => setTimeout(r, 500));
    dealCard("Player");
    await new Promise(r => setTimeout(r, 500));
    dealCard("Dealer");

    document.getElementById("btnDeal").style.visibility = "hidden";

    calcValue();

    if (end == false) {
        document.getElementById("btnHit").style.visibility = "visible";
        document.getElementById("btnStand").style.visibility = "visible";
    }
}

function dealCard(who) {
    var cardValue = cardNumber[Math.floor(Math.random() * 13)];
    var randomCard = cardValue + " " + cardSuit[Math.floor(Math.random() * 4)];

    if (!isCardRepeat(randomCard)) {
        if (who == "Dealer") {
            dealerCard.push(randomCard);
            dealerCardValue.push(cardValue);
            dealerCardNum++;

            if (randomCard.includes("&spades;") || randomCard.includes("&clubs;")) {
                document.getElementById("thDealerCard").innerHTML += '<span class="Card BlackCard">' + randomCard + '</span>';
            }
            else {
                document.getElementById("thDealerCard").innerHTML += '<span class="Card RedCard">' + randomCard + '</span>';
            }
        }
        else {
            playerCard.push(randomCard);
            playerCardValue.push(cardValue);
            playerCardNum++;

            if (randomCard.includes("&spades;") || randomCard.includes("&clubs;")) {
                document.getElementById("thPlayerCard").innerHTML += '<span class="Card BlackCard">' + randomCard + '</span>';
            }
            else {
                document.getElementById("thPlayerCard").innerHTML += '<span class="Card RedCard">' + randomCard + '</span>';
            }
        }
    }
    else {
        dealCard(who);
    }
}

function isCardRepeat(card) {
    var repeat = false;

    if (dealerCard != null) {
        dealerCard.forEach(element => {
            if (card == element) {
                repeat = true;
            }
        });
    }
    if (playerCard != null) {
        playerCard.forEach(element => {
            if (card == element) {
                repeat = true;
            }
        });
    }
    return repeat;
}

async function calcValue() {
    //Win if A+J/Q/K/10 or A+A
    if (dealerCardNum == 2) {
        if (((dealerCardValue[0] == "10" || dealerCardValue[0] == "J" || dealerCardValue[0] == "Q" || dealerCardValue[0] == "K") && (dealerCardValue[1] == "A"))
            || (dealerCardValue[1] == "10" || dealerCardValue[1] == "J" || dealerCardValue[1] == "Q" || dealerCardValue[1] == "K") && (dealerCardValue[0] == "A")
            || (dealerCardValue[0] == "A" && dealerCardValue[1] == "A")) {
            document.getElementById("thDealerValue").innerText = "21";
            end = true;
        }
    }

    if (playerCardNum == 2) {
        if (((playerCardValue[0] == "10" || playerCardValue[0] == "J" || playerCardValue[0] == "Q" || playerCardValue[0] == "K") && (playerCardValue[1] == "A"))
            || (playerCardValue[1] == "J" || playerCardValue[1] == "J" || playerCardValue[1] == "Q" || playerCardValue[1] == "K") && (playerCardValue[0] == "A")
            || (playerCardValue[0] == "A" && playerCardValue[1] == "A")) {
            document.getElementById("thPlayerValue").innerText = "21";
            end = true;
        }
    }
    var winner = 0;

    var tempValue = 0;
    //Got logic error i think for "A" part
    if (end == false) {
        dealerCardValue.forEach(element => {
            if (element == "J" || element == "Q" || element == "K" || element == "10") {
                tempValue += 10;
            }
            else if (element == "A") {
                if (dealerCardNum <= 2) {
                    tempValue += 11;
                }
                else {
                    if ((tempValue + 10) < 21) {
                        tempValue += 10;
                    }
                    else {
                        tempValue += 1;
                    }
                }
            }
            else {
                tempValue += parseInt(element);
            }
        });
        document.getElementById("thDealerValue").innerText = tempValue;

        if (tempValue >= 21) {
            end = true;
            if (tempValue > 21)
                winner = 1;
            else
                winner = 0;
        }


        tempValue = 0;
        playerCardValue.forEach(element => {
            if (element == "J" || element == "Q" || element == "K" || element == "10") {
                tempValue += 10;
            }
            else if (element == "A") {
                if (dealerCardNum <= 2) {
                    tempValue += 11;
                }
                else {
                    if ((tempValue + 10) < 21) {
                        tempValue += 10;
                    }
                    else {
                        tempValue += 1;
                    }
                }
            }
            else {
                tempValue += parseInt(element);
            }
        });
        document.getElementById("thPlayerValue").innerText = tempValue;

        if (tempValue >= 21) {
            end = true;
            if (tempValue > 21) {
                winner = 0;
            }
            else {
                winner = 1;
            }
        }
    }

    if (end == true) {
        document.getElementById("btnHit").style.visibility = "hidden";
        document.getElementById("btnStand").style.visibility = "hidden";
        if (winner == 0) {
            document.getElementById("dealerName").style.color = "green";
        }
        else {
            document.getElementById("playerName").style.color = "green";
        }
    }
}

async function hit() {
    dealCard("Player");
    calcValue();

    if (end == false) {
        if (parseInt(document.getElementById("thDealerValue").innerText) <= 16 && dealerCardNum < 5) {
            await new Promise(r => setTimeout(r, 500));
            dealCard("Dealer");
            calcValue();
        }
    }
}

function stand() {
    document.getElementById("btnHit").style.visibility = "Hidden";
    document.getElementById("btnStand").style.visibility = "Hidden";

    while ((parseInt(document.getElementById("thDealerValue").innerText) <= 16) && dealerCardNum < 5) {
        dealCard("Dealer");
        calcValue();
    }
}