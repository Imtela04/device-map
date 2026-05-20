from passlib.context import CryptContext
from jose import jwt, JWTError
from datetime import datetime, timezone, timedelta

pwd_context = CryptContext(schemes=["bcrypt"])
SECRET_KEY = "your-secret-key-here"
ALGORITHM = "HS256"
EXPIRY_MINUTES = 30

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def create_token(data:dict) -> str :
    payload = data.copy()
    payload['exp'] = datetime.now(timezone.utc)+timedelta(minutes=EXPIRY_MINUTES)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def verify_token(token:str) -> dict :
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except:
        raise JWTError('Invalid Token')
    
    
