
from flask import Blueprint, jsonify
from db import database_available

health_bp = Blueprint("health", __name__)

@health_bp.route("/health")
def health():
    return jsonify({
        "status": "healthy",
        "database": "available" if database_available else "unavailable",
        "message": "NetGuard Backend Service"
    })