from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers.routes import router
from auth.router import router as auth_router
from database import engine, Base

app = FastAPI()
Base.metadata.create_all(bind=engine)

origins = [
    "http://localhost:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix='/api')
app.include_router(auth_router, prefix="/auth")

