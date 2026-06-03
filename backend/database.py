from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy import Column, String, JSON, DateTime
from datetime import datetime, timezone

SQLALCHEMY_DATABASE_URL = "sqlite:///./network.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()

class Route(Base):
  __tablename__ = "routes"
  id         = Column(String, primary_key=True)  # "{from_id}-{to_id}"
  from_id    = Column(String, nullable=False)
  to_id      = Column(String, nullable=False)
  link_type  = Column(String, nullable=False)
  coords     = Column(JSON, nullable=False)       # [[lat,lng], ...]
  updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
