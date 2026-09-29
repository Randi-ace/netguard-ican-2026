import logging

from flask import Blueprint, jsonify, request

from services.log_service import (
    LogPersistenceError,
    LogValidationError,
    log_service,
)


logger = logging.getLogger(__name__)
logs_bp = Blueprint('event_logs', __name__, url_prefix='/api/logs')


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


@logs_bp.route('/risk', methods=['GET'])
def get_risk_logs():
    try:
        data = log_service.get_risk_logs(
            page=request.args.get('page', '1'),
            page_size=request.args.get('page_size', '20'),
        )
        return _success_response(data)
    except LogValidationError as exc:
        return _error_response(str(exc), 400)
    except LogPersistenceError as exc:
        return _error_response(str(exc), 503)
    except Exception:
        logger.exception('风险日志接口发生未预期异常')
        return _error_response('风险日志服务暂时不可用', 500)
