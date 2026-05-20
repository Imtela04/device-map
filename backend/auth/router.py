from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from auth.utils import hash_password, verify_password, create_token
from auth.models import User
from database import SessionLocal
from auth.schemas import UserCreate, UserLogin, TokenResponse
router = APIRouter()
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.post('/signup')
def signup(user:UserCreate, db:Session=Depends(get_db)):
    existing = db.query(User).filter(User.email == user.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already exists")
    hashed = hash_password(user.password)
    new = User(email=user.email, password=hashed, role='noc engineer')
    db.add(new)
    db.commit()
    return 'User created successfully'



@router.post('/login')
def login(user:UserLogin, db:Session=Depends(get_db)):
    existing = db.query(User).filter(User.email == user.email).first()
    if not existing:
        raise HTTPException(status_code=400, detail="User doesn't exist")
    if not verify_password(user.password, existing.password):
        raise HTTPException(status_code=400, detail='Invalid Password')
    token = create_token({"sub": existing.email, "role": existing.role})
    return TokenResponse(token=token, token_type="bearer")
