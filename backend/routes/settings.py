from flask import Blueprint, jsonify, request
from services.settings_service import (
    SettingsPersistenceError,
    SettingsValidationError,
    settings_service,
)

settings_bp = Blueprint("settings", __name__)


@settings_bp.route("/api/settings", methods=["GET"])
def get_settings_api():
    """获取 v1alpha1 统一设置。"""
    try:
        settings_data = settings_service.get_settings()
        return jsonify({
            "code": 0,
            "message": "获取设置成功",
            "data": settings_data
        }), 200
    except SettingsPersistenceError as exc:
        return jsonify({
            "code": 50301,
            "message": str(exc),
            "data": None
        }), 503
    except Exception as exc:
        print(f"❌ 获取设置异常: {str(exc)[:80]}")
        return jsonify({
            "code": 50001,
            "message": "设置服务暂时不可用",
            "data": None
        }), 500


@settings_bp.route("/api/settings", methods=["POST"])
def update_settings_api():
    """更新 v1alpha1 统一设置。"""
    try:
        settings_data = settings_service.update_settings(
            request.get_json(silent=True)
        )
        return jsonify({
            "code": 0,
            "message": "设置更新成功",
            "data": settings_data
        }), 200
    except SettingsValidationError as exc:
        return jsonify({
            "code": 40001,
            "message": str(exc),
            "data": None
        }), 400
    except SettingsPersistenceError as exc:
        return jsonify({
            "code": 50301,
            "message": str(exc),
            "data": None
        }), 503
    except Exception as exc:
        print(f"❌ 更新设置异常: {str(exc)[:80]}")
        return jsonify({
            "code": 50001,
            "message": "设置服务暂时不可用",
            "data": None
        }), 500


@settings_bp.route("/settings/mode", methods=["GET"])
def get_mode():
    try:
        settings_data = settings_service.get_settings()
        return jsonify({
            "mode": settings_data["mode"],
            "updated_at": None
        })
    except Exception as e:
        return jsonify({"error": str(e), "mode": "normal"}), 500

@settings_bp.route("/settings/mode", methods=["POST"])
def set_mode():
    try:
        data = request.get_json(silent=True)
        if not data or "mode" not in data:
            return jsonify({"error": "缺少 mode 参数"}), 400

        settings_data = settings_service.get_settings()
        settings_data["mode"] = data["mode"]
        updated_settings = settings_service.update_settings(settings_data)

        return jsonify({
            "success": True,
            "mode": updated_settings["mode"],
            "updated_at": None
        })
    except SettingsValidationError as e:
        return jsonify({"error": str(e), "success": False}), 400
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500
