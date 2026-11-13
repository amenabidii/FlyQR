import React, { useEffect, useId, useState } from 'react';

const SDK_URL = 'https://www.paypal.com/sdk/js?client-id=BAAZvTd1psl1l9nhyPV2JgDYdN9SGDUmpyWXYITfGZopgjVhgD5Ta00y-rd4z1Z6eDUlX4GoYdeqPH2HEM&components=hosted-buttons&disable-funding=venmo&currency=USD';
let sdkPromise;

function loadPayPal() {
  if (window.paypal?.HostedButtons) return Promise.resolve(window.paypal);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      const timer = setTimeout(() => fail(), 20000);
      function fail() {
        clearTimeout(timer);
        script.remove();
        reject(new Error('PayPal could not load.'));
      }
      script.onload = () => {
        clearTimeout(timer);
        if (window.paypal?.HostedButtons) resolve(window.paypal);
        else fail();
      };
      script.onerror = fail;
      document.head.appendChild(script);
    }).catch(error => { sdkPromise = null; throw error; });
  }
  return sdkPromise;
}

export default function PayPalSupport() {
  const id = 'paypal-container-4Y8Z5NDT5UTG8-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [status, setStatus] = useState('loading');
  useEffect(() => {
    let cancelled = false;
    loadPayPal().then(async paypal => {
      if (cancelled) return;
      await paypal.HostedButtons({ hostedButtonId: '4Y8Z5NDT5UTG8' }).render(`#${id}`);
      if (!cancelled) setStatus('ready');
    }).catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [id]);
  return <section className="paypal-support" aria-label="Support with PayPal">
    <div id={id}/>
    {status === 'loading' && <p role="status">Loading PayPal…</p>}
    {status === 'error' && <p role="status">PayPal couldn’t load. You can still use any of the options below.</p>}
  </section>;
}
