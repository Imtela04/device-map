from database import Base
from sqlalchemy import Column, Integer, String, DateTime
from datetime import datetime, timezone

class User(Base):
    __tablename__ = "users"
    
    id          = Column(Integer, primary_key=True, index=True)
    email       = Column(String, unique=True, nullable=False)
    password    = Column(String, nullable=False)
    role        = Column(String)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))