"""
main.py — KAI Cloud API v3.1
Phase 4: translation + contacts/calling
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.audio import router as audio_router
from routers.turn import router as turn_router
from routers.speaker import router as speaker_router
from routers.memory import router as memory_router
from routers.translate import router as translate_router
from routers.contacts import router as contacts_router

app = FastAPI(
    title="KAI Cloud API",
    version="3.1",
    description="Voice AI backend for KAI smart glasses"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audio_router)
app.include_router(turn_router)
app.include_router(speaker_router)
app.include_router(memory_router)
app.include_router(translate_router)
app.include_router(contacts_router)


@app.get("/health")
def health():
    return {"status": "ok", "version": "3.1"}
