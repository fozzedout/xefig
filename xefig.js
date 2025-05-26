// Encryption and message handling functions
let group = '';
let encryptionKey = null;

async function hash(sourceBytes) {
  const digest = await crypto.subtle.digest("SHA-1", sourceBytes);
  const resultBytes = [...new Uint8Array(digest)];
  return resultBytes.map(x => x.toString(16).padStart(2, '0')).join("");
}

async function deriveKey(imageData) {
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

  messages.forEach(message => {
    const escapedName = escapeHtml(message?.name);
    const escapedMessage = escapeHtml(message?.message);

    html += `
      <div class="flex items-start space-x-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg shadow-md">
        <strong>${escapedName}</strong>
        <p>${escapedMessage}</p>
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
    document.getElementById(containerId).innerHTML = `<p class="text-red-500">Invalid image group</p>`;
    return;
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
    const response = await fetch('https://messages.xefig.workers.dev?g=' + group);
    const data = await response.json();
    const decryptedMessages = await Promise.all(
      data.map(async (msg) => {
        const decryptedName = await decryptData(msg.name);
        const decryptedMessage = await decryptData(msg.message);
        return {
          name: typeof decryptedName === 'object' ? decryptedName.name : decryptedName,
          message: typeof decryptedMessage === 'object' ? decryptedMessage.message : decryptedMessage
        };
      })
    );
    renderMessages(decryptedMessages, containerId);
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
      const response = await fetch('https://messages.xefig.workers.dev?g=' + group, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonData,
      });
      const data = await response.json();
      const decryptedMessages = await Promise.all(
        data.map(async (msg) => {
          const decryptedName = await decryptData(msg.name);
          const decryptedMessage = await decryptData(msg.message);
          return {
            name: typeof decryptedName === 'object' ? decryptedName.name : decryptedName,
            message: typeof decryptedMessage === 'object' ? decryptedMessage.message : decryptedMessage
          };
        })
      );
      renderMessages(decryptedMessages, containerId);
    } catch (error) {
      console.error(error);
    }
  }
} 