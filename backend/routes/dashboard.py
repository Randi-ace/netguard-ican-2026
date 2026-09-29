import logging

from flask import Blueprint, jsonify, request

from services.dashboard_service import (
    DashboardPersistenceError,
    DashboardValidationError,
    dashboard_service,
)


logger = logging.getLogger(__name__)
dashboard_bp = Blueprint(
    'dashboard',
    __name__,
    url_prefix='/api/dashboard',
)


def _success_response(data):
    return jsonify({
        'code': 0,
        'message': 'success',
        'data': data,
    }), 200


def _error_response(message, http_status):
    return jsonify({
        'code': http_status,
        'message': message,
        'data': None,
    }), http_status


@dashboard_bp.route('/overview', methods=['GET'])
def get_overview():
    try:
        return _success_response(dashboard_service.get_overview())
    except DashboardPersistenceError as exc:
        return _error_response(str(exc), 503)
    except Exception:
        logger.exception('Dashboard 总览接口发生未预期异常')
        return _error_response('Dashboard服务暂时不可用', 500)


@dashboard_bp.route('/trend', methods=['GET'])
def get_trend():
    try:
        return _success_response(
            dashboard_service.get_trend(request.args.get('days', '7'))
        )
    except DashboardValidationError as exc:
        return _error_response(str(exc), 400)
    except DashboardPersistenceError as exc:
        return _error_response(str(exc), 503)
    except Exception:
        logger.exception('Dashboard 趋势接口发生未预期异常')
        return _error_response('Dashboard服务暂时不可用', 500)


@dashboard_bp.route('/risk-distribution', methods=['GET'])
def get_risk_distribution():
    try:
        return _success_response(
            dashboard_service.get_risk_distribution()
        )
    except DashboardPersistenceError as exc:
        return _error_response(str(exc), 503)
    except Exception:
        logger.exception('风险等级分布接口发生未预期异常')
        return _error_response('Dashboard服务暂时不可用', 500)
