require('dotenv').config();
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const moment = require('moment-timezone');

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
const minimumTrackingMinutes = 60;
const minimumDistance = 5;

// Create and Deploy Your First Cloud Functions
// https://firebase.google.com/docs/functions/write-firebase-functions

function getClientTokens(userUid) {
  return db.collection('clients').doc(userUid).collection('tokens').get();
}

function getMerchantTokens(merchantUid) {
  return db.collection('merchants').doc(merchantUid).collection('tokens').get();
}

function getMerchantById(merchantUid) {
  return db.collection('merchants').doc(merchantUid).get();
}

function getClientOrders(userUid) {
  return db.collection('orders').where('userUid', '==', userUid).get();
}

function updateClient(userUid, updates) {
  return db.collection('clients').doc(userUid).update(updates);
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

// Converts numeric degrees to radians
function toRad(val) {
  return (val * Math.PI) / 180;
}

// This function takes in latitude and longitude of two location
// and returns the distance between them as the crow flies (in km)
function calcDistanceInKm(pos1, pos2) {
  const lon1 = pos1.longitude;
  const lon2 = pos2.longitude;

  const R = 6371; // km
  const dLat = toRad(pos2.latitude - pos1.latitude);
  const dLon = toRad(lon2 - lon1);
  const lat1 = toRad(pos1.latitude);
  const lat2 = toRad(pos2.latitude);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;
  return d;
}

function parseLocation(val) {
  const arr = val.split(',');
  return {
    latitude: arr[0].trim(),
    longitude: arr[1].trim(),
  };
}

// Check if minimum eligible duration for tracking is available
function isCustomerTime(order) {
  const nowDate = moment(new Date()).tz('Asia/Makassar');
  const orderDate = moment(order.orderDate);
  // minus 8 hour to match gmt+8
  orderDate.add(-8, 'hours');
  const duration = moment.duration(orderDate.diff(nowDate));
  return duration.asMinutes() < minimumTrackingMinutes;
}

// Check if minimum eligible distance for tracking is available
function isCustomerNear(clientLocation, merchantLocation) {
  const pos1 = parseLocation(clientLocation);
  const pos2 = parseLocation(merchantLocation);
  return calcDistanceInKm(pos1, pos2) < minimumDistance;
}

exports.listenClientLocation = functions.firestore
  .document('clients/{uid}')
  .onUpdate(async (change, context) => {
    console.log(context.uid);

    const previousLocation = change.before.data().locationCoordinate;
    const { uid, locationCoordinate, nearFCMSent } = change.after.data();
    console.log(uid);
    if (previousLocation === locationCoordinate) return;
    if (nearFCMSent) return;

    const orders = await getClientOrders(uid);
    console.log(orders);

    if (orders == null) return;

    orders.forEach(async (order) => {
      const currOS = order.data().orderStatus;
      const isOrderOnProgress = currOS[currOS.length - 1] === orderStatus.onProgress;
      console.log('part 1');
      if (isCustomerTime(order.data()) && isOrderOnProgress) {
        console.log('part 2');
        const { merchantUid } = order.data();
        const snapshot = await getMerchantById(merchantUid);
        const merchantLocation = snapshot.data().locationCoordinate;
        if (isCustomerNear(locationCoordinate, merchantLocation)) {
          console.log('part 3');
          const tokens = await getMerchantTokens(merchantUid);
          tokens.forEach(async (doc) => {
            const { token } = doc.data();
            await sendFCM(token, 'Customer is on the way, please start preparing');
          });
        }
      }
    });

    if (orders != null) {
      await updateClient(uid, { nearFCMSent: true });
    }
  });

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
    if (currOs[currOs.length - 1] === orderStatus.done) {
      await updateClient(currentVal.uid, { nearFCMSent: false });
    }
    if (currOs[currOs.length - 1] === orderStatus.cancelled) {
      await updateClient(currentVal.uid, { nearFCMSent: false });
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
