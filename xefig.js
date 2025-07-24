// Encryption and message handling functions
let group = '';
let encryptionKey = null;
let lastMessageId = 0;

async function hash(sourceBytes) {
  if (!crypto.subtle) {
    console.error('Web Crypto API not available');
    document.getElementById('result').innerHTML = `
      <p class="text-red-500">Web Crypto API not available. Please ensure you're using HTTPS or localhost.</p>
      <p class="text-red-500">If using Brave, try disabling shields or using a different browser.</p>
    `;
    return "1ceaf73df40e531df3bfb26b4fb7cd95fb7bff1d";
  }
  const digest = await crypto.subtle.digest("SHA-1", sourceBytes);
  const resultBytes = [...new Uint8Array(digest)];
  return resultBytes.map(x => x.toString(16).padStart(2, '0')).join("");
}

async function deriveKey(imageData) {
  if (!crypto.subtle) {
    console.error('Web Crypto API not available');
    return null;
  }
  const keyMaterial = imageData.slice(0, 32);
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  return key;
}

async function encryptData(data) {
  if (!encryptionKey) return data;
  
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedData = encoder.encode(JSON.stringify(data));
  
  const encryptedData = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    encryptionKey,
    encodedData
  );

  const result = new Uint8Array(iv.length + encryptedData.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encryptedData), iv.length);
  
  return btoa(String.fromCharCode(...result));
}

async function decryptData(encryptedData) {
  if (!encryptionKey) return encryptedData;
  
  try {
    const data = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));
    const iv = data.slice(0, 12);
    const encryptedContent = data.slice(12);
    
    const decryptedData = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      encryptionKey,
      encryptedContent
    );
    
    return JSON.parse(new TextDecoder().decode(decryptedData));
  } catch (error) {
    return encryptedData;
  }
}

async function setGroupFromImage(image) {
  const canvas = document.createElement('canvas');
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  canvas.width = image.width;
  canvas.height = image.height;
  ctx.drawImage(image, 0, 0);

  var imgData = ctx.getImageData(0, 0, image.width, image.height);
  
  const groupHash = await hash(imgData.data);
  group = groupHash;
  encryptionKey = await deriveKey(imgData.data);
  
  return group;
}

function linkify(text) {
  // This regex matches http/https links
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, url =>
  `<a href="${url}" class="text-blue-700 dark:text-blue-300 underline" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMessages(messages, containerId) {
  let html = '';
  console.log('Messages:', messages);

  messages.forEach(message => {
    const escapedName = escapeHtml(message?.name);
    const escapedMessage = linkify(escapeHtml(message?.message));
    const rating = message?.rating || 0;
    const id = message?.id;
    console.log('Message:', { id, rating, name: message?.name, message: message?.message });

    html += `
      <div class="flex items-center space-x-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg shadow-md">
        <strong>${escapedName}:</strong>
        <p class="flex-1">${escapedMessage}</p>
        ${
          rating <= 100
          ? `<div class="flex items-center space-x-1">
          <button onclick="vote('${id}', 'up')" class="text-gray-500 hover:text-blue-500 p-1">
          <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>
          </svg>
          </button>
          <span class="text-sm">${rating}</span>
          <button onclick="vote('${id}', 'down')" class="text-gray-500 hover:text-blue-500 p-1">
          <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
          </button>
          </div>`
          : ''
        }
      </div>
    `;
  });

  document.getElementById(containerId).innerHTML = html;
}

async function fetchMessages(containerId) {
  const image = document.getElementById("image");
  if (!image.src || image.src === window.location.href) {
    return;
  }

  if (group === "" || group === "1ceaf73df40e531df3bfb26b4fb7cd95fb7bff1d") {
    console.log("group " + group);
    document.getElementById(containerId).innerHTML = `<p class="text-red-500">Invalid image group</p>`;
    return;
  }

  if (lastMessageId === 0) {
    document.getElementById(containerId).innerHTML = '';
  }

  const loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'loading-indicator';
  loadingIndicator.className = 'fixed bottom-4 right-4 bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg opacity-0 transition-opacity duration-300 z-50';
  loadingIndicator.style.position = 'fixed';
  loadingIndicator.style.bottom = '1rem';
  loadingIndicator.style.right = '1rem';
  loadingIndicator.textContent = 'Loading messages...';
  document.body.appendChild(loadingIndicator);
  setTimeout(() => loadingIndicator.classList.remove('opacity-0'), 100);

  try {
    const response = await fetch(`https://messages.xefig.workers.dev/messages?g=${group}&id=${lastMessageId}`);
    const data = await response.json();
    const decryptedMessages = await Promise.all(
      data.map(async (msg) => {
        const decryptedName = await decryptData(msg.name);
        const decryptedMessage = await decryptData(msg.message);
        if (msg.id > lastMessageId) {
          lastMessageId = msg.id;
        }
        return {
          id: msg.id,
          rating: msg.rating,
          name: typeof decryptedName === 'object' ? decryptedName.name : decryptedName,
          message: typeof decryptedMessage === 'object' ? decryptedMessage.message : decryptedMessage
        };
      })
    );
    
    if (lastMessageId === 0) {
      document.getElementById(containerId).innerHTML = '';
      renderMessages(decryptedMessages, containerId);
    } else {
      const existingMessages = document.getElementById(containerId).innerHTML;
      const newMessages = decryptedMessages.map(msg => `
      <div class="flex items-center space-x-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg shadow-md">
      <strong>${escapeHtml(msg.name)}:</strong>
      <p class="flex-1">${linkify(escapeHtml(msg.message))}</p>
      ${
        msg.rating <= 100
        ? `<div class="flex items-center space-x-1">
        <button onclick="vote('${msg.id}', 'up')" class="text-gray-500 hover:text-blue-500 p-1">
        <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>
        </svg>
        </button>
        <span class="text-sm">${msg.rating}</span>
        <button onclick="vote('${msg.id}', 'down')" class="text-gray-500 hover:text-blue-500 p-1">
        <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
        </button>
        </div>`
        : ''
      }
      </div>
      `).join('');

      document.getElementById(containerId).innerHTML = newMessages + existingMessages;
    }
  } catch (error) {
    console.error(error);
    document.getElementById(containerId).innerHTML = `<p class="text-red-500">Failed to load messages</p>`;
  } finally {
    loadingIndicator.classList.add('opacity-0');
    setTimeout(() => loadingIndicator.remove(), 300);
  }
}

async function sendMessage(name, message, containerId) {
  if (group === "" || group === "1ceaf73df40e531df3bfb26b4fb7cd95fb7bff1d") {
    document.getElementById(containerId).innerHTML = `<p class="text-red-500">Invalid image group</p>`;
    return;
  }

  if (name && message) {
    localStorage.setItem('name', name);

    const encryptedName = await encryptData({ name });
    const encryptedMessage = await encryptData({ message });

    const jsonData = JSON.stringify({ 
      name: encryptedName, 
      message: encryptedMessage 
    });

    try {
      const response = await fetch('https://messages.xefig.workers.dev/messages?g=' + group, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonData,
      });
      if (response.ok) {
        fetchMessages(containerId);
      }
    } catch (error) {
      console.error(error);
    }
  }
}

async function vote(id, direction) {
  try {
    const response = await fetch(`https://messages.xefig.workers.dev/messages/${id}/${direction}`, {
      method: 'POST'
    });
    if (response.ok) {
      const button = document.querySelector(`button[onclick="vote('${id}', '${direction}')"]`);
      const ratingSpan = button.parentElement.querySelector('span');
      const currentRating = parseInt(ratingSpan.textContent);
      ratingSpan.textContent = direction === 'up' ? currentRating + 1 : currentRating - 1;
    }
  } catch (error) {
    console.error('Vote error:', error);
  }
}

image.addEventListener('load', async () => {
  lastMessageId = 0;
  await setGroupFromImage(image);
});

reloadMessages.addEventListener('click', () => {
  lastMessageId = 0;
  fetchMessages('result');
}); 
