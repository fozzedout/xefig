let group = '';
let encryptionKey = null;
let lastPostId = 0;

async function hash(sourceBytes) {
  if (!crypto.subtle) {
    console.error('Web Crypto API not available');
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

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date) {
  const now = new Date();
  const diff = now - new Date(date);
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} days ago`;
  if (hours > 0) return `${hours} hours ago`;
  if (minutes > 0) return `${minutes} minutes ago`;
  return 'just now';
}

function renderPost(post) {
  const escapedTitle = escapeHtml(post.title);
  const escapedContent = escapeHtml(post.content);
  const escapedAuthor = escapeHtml(post.author);
  const rating = post.rating || 0;
  const id = post.id;
  const date = formatDate(post.date);

  return `
    <article class="bg-white dark:bg-gray-800 rounded-lg shadow flex">
      <!-- Voting Bar -->
      <div class="flex flex-col items-center justify-start p-2 space-y-1 bg-gray-50 dark:bg-gray-700 rounded-l-lg">
        <button onclick="votePost('${id}', 'up')" class="text-gray-500 hover:text-blue-500 p-1">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>
          </svg>
        </button>
        <span class="font-medium text-gray-900 dark:text-white">${rating}</span>
        <button onclick="votePost('${id}', 'down')" class="text-gray-500 hover:text-blue-500 p-1">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
      </div>

      <!-- Post Content -->
      <div class="flex-1 p-4">
        <div class="mb-2">
          <h2 class="text-xl font-semibold text-gray-900 dark:text-white">${escapedTitle}</h2>
          <div class="flex items-center space-x-2 text-sm text-gray-500 dark:text-gray-400">
            <span>Posted by ${escapedAuthor}</span>
            <span>•</span>
            <span>${date}</span>
          </div>
        </div>
        <p class="text-gray-700 dark:text-gray-300 mb-4">${escapedContent}</p>
        <button onclick="toggleComments('${id}')" class="text-gray-500 hover:text-blue-500 flex items-center space-x-1">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
          <span>${post.comments?.length || 0} Comments</span>
        </button>
      </div>
    </article>
    
    <!-- Comments Section -->
    <div id="comments-${id}" class="hidden mt-2 ml-8 space-y-4">
      ${renderComments(post.comments || [])}
      
      <!-- New Comment Form -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <form onsubmit="submitComment(event, '${id}')" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Your Name</label>
            <input type="text" required name="author"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Comment</label>
            <textarea required name="content" rows="3"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"></textarea>
          </div>
          <div class="flex justify-end">
            <button type="submit"
              class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg">
              Post Comment
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderComments(comments) {
  return comments.map(comment => {
    const escapedAuthor = escapeHtml(comment.author);
    const escapedContent = escapeHtml(comment.content);
    const date = formatDate(comment.date);
    const rating = comment.rating || 0;
    const id = comment.id;

    return `
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow flex">
        <!-- Voting Bar -->
        <div class="flex flex-col items-center justify-start p-2 space-y-1 bg-gray-50 dark:bg-gray-700 rounded-l-lg">
          <button onclick="voteComment('${id}', 'up')" class="text-gray-500 hover:text-blue-500 p-1">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/>
            </svg>
          </button>
          <span class="font-medium text-gray-900 dark:text-white">${rating}</span>
          <button onclick="voteComment('${id}', 'down')" class="text-gray-500 hover:text-blue-500 p-1">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
            </svg>
          </button>
        </div>

        <!-- Comment Content -->
        <div class="flex-1 p-4">
          <div class="flex items-center justify-between mb-2">
            <span class="font-medium text-gray-900 dark:text-white">${escapedAuthor}</span>
            <span class="text-sm text-gray-500 dark:text-gray-400">${date}</span>
          </div>
          <p class="text-gray-700 dark:text-gray-300">${escapedContent}</p>
        </div>
      </div>
    `;
  }).join('');
}

async function fetchPosts() {
  if (group === "" || group === "1ceaf73df40e531df3bfb26b4fb7cd95fb7bff1d") {
    console.log("group " + group);
    document.getElementById('posts').innerHTML = `<p class="text-red-500">Invalid image group</p>`;
    return;
  }

  try {
    const response = await fetch(`https://messages.xefig.workers.dev/posts?g=${group}&id=${lastPostId}`);
    const data = await response.json();
    const decryptedPosts = await Promise.all(
      data.map(async (post) => {
        const decryptedTitle = await decryptData(post.title);
        const decryptedContent = await decryptData(post.content);
        const decryptedAuthor = await decryptData(post.author);
        if (post.id > lastPostId) {
          lastPostId = post.id;
        }
        return {
          id: post.id,
          rating: post.rating,
          date: post.date,
          title: typeof decryptedTitle === 'object' ? decryptedTitle.title : decryptedTitle,
          content: typeof decryptedContent === 'object' ? decryptedContent.content : decryptedContent,
          author: typeof decryptedAuthor === 'object' ? decryptedAuthor.author : decryptedAuthor,
          comments: post.comments || []
        };
      })
    );
    
    const postsHtml = decryptedPosts.map(post => renderPost(post)).join('');
    document.getElementById('posts').innerHTML = postsHtml;
  } catch (error) {
    console.error(error);
    document.getElementById('posts').innerHTML = `<p class="text-red-500">Failed to load posts</p>`;
  }
}

async function submitPost(event) {
  event.preventDefault();
  
  const author = document.getElementById('authorName').value;
  const title = document.getElementById('postTitle').value;
  const content = document.getElementById('postContent').value;

  if (!author || !title || !content) return;

  const encryptedAuthor = await encryptData({ author });
  const encryptedTitle = await encryptData({ title });
  const encryptedContent = await encryptData({ content });

  try {
    const response = await fetch('https://messages.xefig.workers.dev/posts?g=' + group, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: encryptedAuthor,
        title: encryptedTitle,
        content: encryptedContent
      })
    });
    
    if (response.ok) {
      document.getElementById('newPostForm').classList.add('hidden');
      document.getElementById('postForm').reset();
      fetchPosts();
    }
  } catch (error) {
    console.error(error);
  }
}

async function submitComment(event, postId) {
  event.preventDefault();
  
  const form = event.target;
  const author = form.author.value;
  const content = form.content.value;

  if (!author || !content) return;

  const encryptedAuthor = await encryptData({ author });
  const encryptedContent = await encryptData({ content });

  try {
    const response = await fetch(`https://messages.xefig.workers.dev/posts/${postId}/comments?g=${group}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: encryptedAuthor,
        content: encryptedContent
      })
    });
    
    if (response.ok) {
      form.reset();
      fetchPosts();
    }
  } catch (error) {
    console.error(error);
  }
}

async function votePost(id, direction) {
  try {
    const response = await fetch(`https://messages.xefig.workers.dev/posts/${id}/${direction}?g=${group}`, {
      method: 'POST'
    });
    if (response.ok) {
      fetchPosts();
    }
  } catch (error) {
    console.error('Vote error:', error);
  }
}

async function voteComment(id, direction) {
  try {
    const response = await fetch(`https://messages.xefig.workers.dev/comments/${id}/${direction}?g=${group}`, {
      method: 'POST'
    });
    if (response.ok) {
      fetchPosts();
    }
  } catch (error) {
    console.error('Vote error:', error);
  }
}

function toggleComments(postId) {
  const commentsDiv = document.getElementById(`comments-${postId}`);
  commentsDiv.classList.toggle('hidden');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const image = document.getElementById('image');
  if (image) {
    image.addEventListener('load', async () => {
      lastPostId = 0;
      await setGroupFromImage(image);
      fetchPosts();
    });
  }

  // Set up polling
  let pollInterval;
  let inactivityTimeout;
  const INACTIVITY_DELAY = 5 * 60 * 1000; // 5 minutes
  const POLL_INTERVAL = 30000; // 30 seconds

  function startPolling() {
    if (!pollInterval) {
      pollInterval = setInterval(fetchPosts, POLL_INTERVAL);
    }
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function resetInactivityTimer() {
    if (inactivityTimeout) {
      clearTimeout(inactivityTimeout);
    }
    inactivityTimeout = setTimeout(stopPolling, INACTIVITY_DELAY);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
      resetInactivityTimer();
    }
  });

  document.addEventListener('mousemove', resetInactivityTimer);
  document.addEventListener('keypress', resetInactivityTimer);
  document.addEventListener('click', resetInactivityTimer);

  startPolling();
  resetInactivityTimer();
}); 