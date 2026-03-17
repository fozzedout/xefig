document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('upload-form');
  const fileInput = document.getElementById('image');
  const fileCustom = document.querySelector('.file-custom');
  const submitBtn = document.getElementById('submit-btn');
  const toast = document.getElementById('toast');
  
  // Set default date to today
  document.getElementById('date').valueAsDate = new Date();

  // Update file input text
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      fileCustom.innerHTML = e.target.files[0].name;
      fileCustom.style.color = 'var(--text-main)';
    } else {
      fileCustom.innerHTML = 'Choose image...';
      fileCustom.style.color = 'var(--text-muted)';
    }
  });

  function showToast(message, type) {
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    
    setTimeout(() => {
      toast.classList.remove('show');
    }, 4000);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Disable form UI during submission
    const originalBtnText = submitBtn.textContent;
    submitBtn.textContent = 'Uploading...';
    submitBtn.disabled = true;

    try {
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      
      const formData = new FormData(form);
      // We don't want to send credentials in the payload, just the file/metadata
      formData.delete('username');
      formData.delete('password');

      // Create Basic Auth Header
      const credentials = btoa(`${username}:${password}`);
      
      // Determine API URL based on environment
      // In a real app we might use vite env vars, but for dev we assume worker runs on 8787
      const apiUrl = window.location.hostname === 'localhost' 
        ? 'http://localhost:8787/api/upload' 
        : '/api/upload';

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`
        },
        body: formData
      });

      const result = await response.json();

      if (response.ok) {
        showToast('Puzzle uploaded successfully!', 'success');
        // Reset specific fields but keep credentials
        form.reset();
        document.getElementById('username').value = username;
        document.getElementById('password').value = password;
        document.getElementById('date').valueAsDate = new Date(); // Reset date
        
        fileCustom.innerHTML = 'Choose image...';
        fileCustom.style.color = 'var(--text-muted)';
      } else {
        showToast(result.error || 'Failed to upload puzzle.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('A network error occurred.', 'error');
    } finally {
      submitBtn.textContent = originalBtnText;
      submitBtn.disabled = false;
    }
  });
});
