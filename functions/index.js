require('dotenv').config();
const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: process.env.DB_URL,
});

const db = admin.firestore();
const orderStatus = {
  waitingMerchantConfirmation: 'WAITING_MERCHANT_CONFIRMATION',
  waitingPayment: 'WAITING_PAYMENT',
  onProgress: 'ON_PROGRESS',
  cancelled: 'CANCELLED',
  done: 'DONE',
};

// Create and Deploy Your First Cloud Functions
// https://firebase.google.com/docs/functions/write-firebase-functions

function getClientTokens(userUid) {
  return new Promise((resolve, reject) => {
    db.collection('clients')
      .doc(userUid)
      .collection('tokens')
      .get()
      .then((result) => resolve(result))
      .catch((result) => reject(result));
  });
}

function getMerchantTokens(merchantUid) {
  return new Promise((resolve, reject) => {
    db.collection('merchants')
      .doc(merchantUid)
      .collection('tokens')
      .get()
      .then((result) => resolve(result))
      .catch((result) => reject(result));
  });
}

function parseMessage(message, isClient) {
  if (message === orderStatus.waitingMerchantConfirmation) {
    if (isClient) return 'Reservation request sent!';
    return 'We have a new customer!';
  }
  if (message === orderStatus.waitingPayment) {
    if (isClient) return 'Reservation accepted, please pay to proceed';
    return 'Reservation confirmed, waiting for payment';
  }
  if (message === orderStatus.onProgress) {
    if (isClient) return 'Reservation paid!';
    return 'Reservation paid!';
  }
  if (message === orderStatus.cancelled) return 'Reservation cancelled';
  if (message === orderStatus.done) return 'Reservation Done, Thank You!';
  return message;
}

function sendFCM(token, message) {
  return new Promise((resolve, reject) => {
    const payLoad = {
      notification: {
        body: 'Please check Order(s) for more information',
        title: message,
      },
    };
    admin
      .messaging()
      .sendToDevice(token, payLoad)
      .then((result) => resolve(result))
      .catch((result) => reject(result));
  });
}

exports.listenOrderStatus = functions.firestore
  .document('orders/{uid}')
  .onUpdate(async (change, context) => {
    // Documents
    const previousVal = change.before.data();
    const currentVal = change.after.data();
    console.log(context.params.uid);
    // Order Statuses
    const prevOS = previousVal.orderStatus;
    const currOs = currentVal.orderStatus;

    if (prevOS.length === currOs.length) {
      console.log('no order status changes');
      return null;
    }
    console.log('currentVal.userUid =>', currentVal.userUid);
    console.log('currentVal.merchantUid =>', currentVal.merchantUid);

    const clientTokens = await getClientTokens(currentVal.userUid);
    clientTokens.forEach(async (doc) => {
      const { token } = doc.data();
      console.log(token);
      await sendFCM(token, parseMessage(currOs[currOs.length - 1], true));
    });

    const merchantTokens = await getMerchantTokens(currentVal.merchantUid);
    merchantTokens.forEach(async (doc) => {
      const { token } = doc.data();
      console.log(token);
      await sendFCM(token, parseMessage(currOs[currOs.length - 1], true));
    });

    return null;
  });
