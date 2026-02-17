import streamlit as st
import os
import pickle
from datetime import datetime
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# --- CONFIGURATION ---
DRIVE_FOLDER_ID = "15uIcHh_Ku-_0eS4GONR4-asIdeCdbtLO" 
SCOPES = ['https://www.googleapis.com/auth/drive.file']

# --- GOOGLE DRIVE FUNCTIONS (Unchanged) ---
def get_drive_service():
    """Authenticates using your personal Google Account."""
    creds = None
    if os.path.exists('token.pickle'):
        with open('token.pickle', 'rb') as token:
            creds = pickle.load(token)
            
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists('client_secret.json'):
                st.error("❌ Missing 'client_secret.json'.")
                return None
            flow = InstalledAppFlow.from_client_secrets_file('client_secret.json', SCOPES)
            creds = flow.run_local_server(port=0)
            
        with open('token.pickle', 'wb') as token:
            pickle.dump(creds, token)

    return build('drive', 'v3', credentials=creds)

def upload_to_personal_drive(filepath, filename):
    service = get_drive_service()
    if not service:
        return None

    file_metadata = {
        'name': filename,
        'parents': [DRIVE_FOLDER_ID]
    }
    media = MediaFileUpload(filepath, mimetype='audio/wav')
    
    try:
        file = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id'
        ).execute()
        return file.get('id')
    except Exception as e:
        st.error(f"Google Drive Error: {e}")
        return None

# --- SESSION STATE INITIALIZATION ---
# This 'refresh_key' is the trick. Every time we change it, 
# the audio widget is destroyed and recreated fresh.
if 'refresh_key' not in st.session_state:
    st.session_state.refresh_key = 0

# --- STREAMLIT UI ---

# 1. Centered & Styled Heading
st.markdown(
    """
    <h1 style='text-align: center; color: #E74C3C;'>
        🎙️ Audio Recorder for MOM
    </h1>
    <p style='text-align: center; color: gray;'>
        Records are automatically synced to Google Drive
    </p>
    <hr>
    """, 
    unsafe_allow_html=True
)

# 2. The Recorder Widget
# We use the key=... argument. When this key changes, the widget resets.
audio_value = st.audio_input(
    "Record Meeting", 
    key=f"recorder_{st.session_state.refresh_key}"
)

# 3. Processing Logic
if audio_value:
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"Meeting_{timestamp}.wav"
    
    # Check if we already processed THIS specific file to avoid double uploads loop
    # We use a specific flag for the current key
    current_session_processed = f"processed_{st.session_state.refresh_key}"
    
    if current_session_processed not in st.session_state:
        # --- UPLOAD PROCESS ---
        status = st.status(f"Processing '{filename}'...", expanded=True)
        
        status.write("💾 Saving temporary file...")
        with open(filename, "wb") as f:
            f.write(audio_value.read())
        
        status.write("☁️ Uploading to Google Drive...")
        file_id = upload_to_personal_drive(filename, filename)
        
        if file_id:
            status.update(label="✅ Upload Complete!", state="complete", expanded=False)
            st.success(f"Successfully saved to Drive! (ID: {file_id})")
            
            # Mark this session as "Done" so we don't re-upload on generic refreshes
            st.session_state[current_session_processed] = True
            
            # Remove local file
            if os.path.exists(filename):
                os.remove(filename)
        else:
            status.update(label="❌ Upload Failed", state="error")
    
    # --- 4. THE "RESET" BUTTON ---
    # Only show this button if the upload is done
    if current_session_processed in st.session_state:
        st.write("") # Spacer
        st.write("---")
        col1, col2, col3 = st.columns([1, 2, 1])
        with col2:
            # When clicked, we increment the key and RERUN the app.
            # This makes the audio widget "forget" the old file and show empty.
            if st.button("🔄 Record New Meeting", use_container_width=True):
                st.session_state.refresh_key += 1
                st.rerun()